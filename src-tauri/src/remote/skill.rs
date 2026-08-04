//! 远端 Skills SSOT 管理。
//!
//! 与本机架构完全对称：
//! - SSOT 物理目录：`~/.cc-switch/skills/{name}/`
//! - 元数据文件：`~/.cc-switch/skills.json`（JSON 数组，SFTP 读 / 原子写回）
//! - 同步：各应用 skills 目录下创建 symlink 指向 SSOT
//!
//! 通过 `FileOps` 接口支持三种数据源：本机（std::fs）/ 宿主机（SFTP）/ 容器内（docker exec）。

use std::collections::HashMap;
use std::path::Path;

use russh_sftp::client::SftpSession;
use serde::{Deserialize, Serialize};

use crate::fsops::FileOps;

use super::sftp_io::ensure_remote_dir;

// ========================================================================
// 路径
// ========================================================================

/// 远端 SSOT 技能目录（根据本机「技能存储位置」设置）。
pub fn remote_ssot_path(root: &str) -> String {
    match crate::settings::get_skill_storage_location() {
        crate::services::skill::SkillStorageLocation::Unified => {
            format!("{root}/.agents/skills")
        }
        _ => format!("{root}/.cc-switch/skills"),
    }
}

/// 远端 `~/.claude/skills` 目录路径。
pub fn remote_claude_skills_path(root: &str) -> String {
    format!("{root}/.claude/skills")
}

/// 远端 skills.json 路径（跟 SSOT 目录同级）。
pub(crate) fn remote_skills_json_path(root: &str) -> String {
    let ssot = remote_ssot_path(root);
    // ~/.cc-switch/skills.json 或 ~/.agents/skills.json
    if let Some(parent) = ssot.rsplit_once('/').map(|(p, _)| p) {
        format!("{parent}/skills.json")
    } else {
        format!("{root}/skills.json")
    }
}

// ========================================================================
// 数据结构
// ========================================================================

/// 远端技能应用开关。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSkillApps {
    #[serde(default)]
    pub claude: bool,
    #[serde(default)]
    pub codex: bool,
    #[serde(default)]
    pub gemini: bool,
    #[serde(default)]
    pub opencode: bool,
    #[serde(default)]
    pub openclaw: bool,
    #[serde(default)]
    pub hermes: bool,
}

/// skills.json 中的一条记录。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSkillRecord {
    /// 唯一标识（UUID，与 SQLite id 对齐）。
    #[serde(default)]
    pub id: String,
    /// 显示名（从 SKILL.md 解析，无则回退目录名）。
    pub name: String,
    pub description: Option<String>,
    /// 目录名。
    pub directory: String,
    /// 各应用启用状态。
    #[serde(default)]
    pub apps: RemoteSkillApps,
    #[serde(default)]
    pub installed_at: i64,
    #[serde(default)]
    pub updated_at: i64,
    #[serde(default)]
    pub repo_owner: Option<String>,
    #[serde(default)]
    pub repo_name: Option<String>,
    #[serde(default)]
    pub repo_branch: Option<String>,
    /// README 或文档链接。
    #[serde(default)]
    pub readme_url: Option<String>,
    /// 目录内容哈希（用于更新检查）。
    #[serde(default)]
    pub content_hash: Option<String>,
}

/// 远端技能目录项（前端用）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSkillEntry {
    pub id: String,
    pub name: String,
    pub path: String,
    pub display_name: Option<String>,
    pub description: Option<String>,
    /// 各应用启用状态。
    pub apps: RemoteSkillApps,
    pub installed_at: i64,
    pub updated_at: i64,
    pub repo_owner: Option<String>,
    pub repo_name: Option<String>,
    pub repo_branch: Option<String>,
    pub readme_url: Option<String>,
    pub content_hash: Option<String>,
}

/// 远端未管理技能条目（扫描用）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteUnmanagedSkill {
    pub directory: String,
    pub name: String,
    pub description: Option<String>,
    pub found_in: Vec<String>,
    pub path: String,
}

// ========================================================================
// SSOT 初始化
// ========================================================================

/// 确保远端 SSOT 目录和 skills.json 存在。
/// 首次进入远端 Skills 面板时调用，幂等。
pub async fn init_remote_skills_ssot<F: FileOps>(fs: &F, root: &str) -> Result<(), String> {
    let ssot_dir = remote_ssot_path(root);
    // 通过 SFTP ensure_remote_dir 需要 SftpSession，这里用 FileOps 的 write_text_atomic
    // 触发父目录创建。先确保 SSOT 目录存在：创建 .cc-switch/ + skills/ 目录结构。
    init_ssot_dirs(fs, root).await?;

    let json_path = remote_skills_json_path(root);
    if !fs.exists(&json_path).await {
        fs.write_text_atomic(&json_path, "[]").await?;
    }
    Ok(())
}

/// 通过 SFTP 创建 SSOT 目录结构。
async fn init_ssot_dirs<F: FileOps>(fs: &F, root: &str) -> Result<(), String> {
    let ssot_dir = remote_ssot_path(root);
    let parent_dir = ssot_dir.rsplit_once('/').map(|(p, _)| p).unwrap_or(root);
    for dir in &[&parent_dir.to_string(), &ssot_dir] {
        if !fs.exists(dir).await {
            // 用 write_text_atomic 的副作用（mkdir -p）创建目录
            let marker = format!("{dir}/.ccswitch_placeholder");
            if !fs.exists(&marker).await {
                fs.write_text_atomic(&marker, "").await?;
                let _ = fs.remove_file(&marker).await;
            }
        }
    }
    Ok(())
}

// ========================================================================
// skills.json 读写
// ========================================================================

/// 读取远端 skills.json，返回记录列表。文件缺失或为空时返回空数组。
pub async fn read_remote_skills_json<F: FileOps>(
    fs: &F,
    root: &str,
) -> Result<Vec<RemoteSkillRecord>, String> {
    let path = remote_skills_json_path(root);
    let text = match fs.read_text_optional(&path).await? {
        Some(t) => t,
        None => return Ok(Vec::new()),
    };
    if text.trim().is_empty() {
        return Ok(Vec::new());
    }
    serde_json::from_str(&text).map_err(|e| format!("解析 skills.json 失败: {e}"))
}

/// 原子写入远端 skills.json。
pub async fn write_remote_skills_json<F: FileOps>(
    fs: &F,
    root: &str,
    records: &[RemoteSkillRecord],
) -> Result<(), String> {
    let json = serde_json::to_string_pretty(records)
        .map_err(|e| format!("序列化 skills.json 失败: {e}"))?;
    let path = remote_skills_json_path(root);
    fs.write_text_atomic(&path, &json).await
}

// ========================================================================
// 同步管理（symlink 或 copy）
// ========================================================================

/// 已知应用的 skills 目录列表（相对于 home 的路径）。
const APP_SKILLS_DIRS: &[&str] = &[
    ".claude/skills",
    ".codex/skills",
    ".gemini/skills",
    ".opencode/skills",
    ".openclaw/skills",
    ".hermes/skills",
];

/// 按 apps 开关过滤出要同步的应用目录。
fn enabled_app_dirs(apps: &RemoteSkillApps) -> Vec<&'static str> {
    let map: &[(&str, bool)] = &[
        (".claude/skills", apps.claude),
        (".codex/skills", apps.codex),
        (".gemini/skills", apps.gemini),
        (".opencode/skills", apps.opencode),
        (".openclaw/skills", apps.openclaw),
        (".hermes/skills", apps.hermes),
    ];
    map.iter()
        .filter(|(_, enabled)| *enabled)
        .map(|(dir, _)| *dir)
        .collect()
}

/// 为技能在各应用目录创建链接（symlink 或 copy，取决于 `use_copy`）。
/// 通过 exec 通道在远端执行。
pub async fn sync_remote_skill_links(
    channel: &russh::client::Handle<crate::remote::connection::RemoteHandler>,
    container: Option<&str>,
    root: &str,
    name: &str,
    apps: &RemoteSkillApps,
    use_copy: bool,
) -> Result<(), String> {
    let ssot_dir = remote_ssot_path(root);
    let target = format!("{ssot_dir}/{name}");

    for app_rel in enabled_app_dirs(apps) {
        let link_path = format!("{root}/{app_rel}/{name}");
        let parent = format!("{root}/{app_rel}");

        // 确保父目录存在
        exec_cmd(channel, container, &format!("mkdir -p {}", shell_q(&parent))).await?;
        // 删除旧链接/目录
        exec_cmd(channel, container, &format!("rm -rf {}", shell_q(&link_path))).await?;

        let sync_cmd = if use_copy {
            format!("cp -r {} {}", shell_q(&target), shell_q(&link_path))
        } else {
            format!("ln -s {} {}", shell_q(&target), shell_q(&link_path))
        };
        exec_cmd(channel, container, &sync_cmd).await?;
    }
    Ok(())
}

/// 删除技能在所有应用目录下的链接/副本。
pub async fn remove_remote_skill_links(
    channel: &russh::client::Handle<crate::remote::connection::RemoteHandler>,
    container: Option<&str>,
    root: &str,
    name: &str,
) -> Result<(), String> {
    for app_rel in APP_SKILLS_DIRS {
        let link_path = format!("{root}/{app_rel}/{name}");
        exec_cmd(channel, container, &format!("rm -rf {}", shell_q(&link_path))).await?;
    }
    Ok(())
}

// ========================================================================
// 核心操作
// ========================================================================

/// 列出已安装技能（读 skills.json + SSOT 目录验证）。
pub async fn list_remote_skills<F: FileOps>(
    fs: &F,
    root: &str,
) -> Result<Vec<RemoteSkillEntry>, String> {
    init_remote_skills_ssot(fs, root).await?;
    let records = read_remote_skills_json(fs, root).await?;
    let ssot_dir = remote_ssot_path(root);

    let mut out = Vec::new();
    for rec in &records {
        let skill_dir = format!("{ssot_dir}/{}", rec.directory);
        // 验证 SSOT 目录存在
        if !fs.exists(&skill_dir).await {
            log::warn!("[remote-skill] SSOT 目录不存在: {skill_dir}");
            continue;
        }
        let (display_name, description) = read_skill_md_meta_static(fs, &skill_dir).await;
        log::info!(
            "[remote-skill] name={} display_name={:?} description={:?} json_desc={:?}",
            rec.directory,
            display_name,
            description,
            rec.description,
        );
        out.push(RemoteSkillEntry {
            id: if rec.id.is_empty() { rec.directory.clone() } else { rec.id.clone() },
            display_name: display_name
                .filter(|n| !n.is_empty())
                .or_else(|| Some(rec.name.clone())),
            description: description.or_else(|| rec.description.clone()),
            name: rec.directory.clone(),
            path: skill_dir,
            apps: rec.apps.clone(),
            installed_at: rec.installed_at,
            updated_at: rec.updated_at,
            repo_owner: rec.repo_owner.clone(),
            repo_name: rec.repo_name.clone(),
            repo_branch: rec.repo_branch.clone(),
            readme_url: rec.readme_url.clone(),
            content_hash: rec.content_hash.clone(),
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

/// 删除技能：删 SSOT → 删 symlink → 更新 skills.json。
pub async fn delete_remote_skill<F: FileOps>(
    fs: &F,
    channel: Option<&russh::client::Handle<crate::remote::connection::RemoteHandler>>,
    container: Option<&str>,
    root: &str,
    name: &str,
) -> Result<bool, String> {
    if name.is_empty() || name.contains('/') || name.contains('\\') || name == "." || name == ".." {
        return Err("非法技能名称".to_string());
    }
    let ssot_dir = remote_ssot_path(root);
    let path = format!("{ssot_dir}/{name}");

    // 删 SSOT 目录
    if fs.exists(&path).await && fs.is_dir(&path).await {
        fs.remove_dir_all(&path).await?;
    }

    // 删链接
    if let Some(ch) = channel {
        remove_remote_skill_links(ch, container, root, name).await?;
    }

    // 更新 JSON
    let mut records = read_remote_skills_json(fs, root).await?;
    records.retain(|r| r.directory != name);
    write_remote_skills_json(fs, root, &records).await?;

    Ok(true)
}

// ========================================================================
// 导入已有（远端本地复制）
// ========================================================================

/// 在远端文件系统上扫描未管理的技能目录。
///
/// 遍历远端已知应用 skills 目录，逻辑与本机 scan_unmanaged 一致：
/// 每个目录 → 列子目录 → 跳过无 SKILL.md → 跳过 . 开头 → 跳过已管理 → 去重合并。
pub async fn scan_remote_unmanaged_skills<F: FileOps>(
    fs: &F,
    root: &str,
) -> Result<Vec<RemoteUnmanagedSkill>, String> {
    // 已管理技能：从 skills.json 获取
    let records = read_remote_skills_json(fs, root).await?;
    let managed: std::collections::HashSet<String> =
        records.into_iter().map(|r| r.directory).collect();

    // 扫描来源：各应用的 skills 目录
    let ssot_dir = remote_ssot_path(root);
    let mut sources: Vec<(String, String)> = Vec::new();
    sources.push((ssot_dir.clone(), "cc-switch".to_string()));
    sources.push((remote_claude_skills_path(root), "claude".to_string()));
    sources.push((format!("{root}/.codex/skills"), "codex".to_string()));
    sources.push((format!("{root}/.gemini/skills"), "gemini".to_string()));
    sources.push((format!("{root}/.opencode/skills"), "opencode".to_string()));
    sources.push((format!("{root}/.openclaw/skills"), "openclaw".to_string()));
    sources.push((format!("{root}/.hermes/skills"), "hermes".to_string()));

    let mut unmanaged: HashMap<String, RemoteUnmanagedSkill> = HashMap::new();

    for (src_dir, label) in &sources {
        if !fs.exists(src_dir).await {
            continue;
        }
        let entries = match fs.read_dir(src_dir).await {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries {
            if !entry.is_dir || entry.name.starts_with('.') {
                continue;
            }
            if managed.contains(&entry.name) {
                continue;
            }
            let skill_md = format!("{}/SKILL.md", entry.path);
            if !fs.exists(&skill_md).await {
                continue;
            }
            let (display_name, description) = read_skill_md_meta_static(fs, &entry.path).await;
            unmanaged
                .entry(entry.name.clone())
                .and_modify(|s| s.found_in.push(label.clone()))
                .or_insert(RemoteUnmanagedSkill {
                    directory: entry.name.clone(),
                    name: display_name.unwrap_or_else(|| entry.name.clone()),
                    description,
                    found_in: vec![label.clone()],
                    path: entry.path,
                });
        }
    }

    let mut out: Vec<RemoteUnmanagedSkill> = unmanaged.into_values().collect();
    out.sort_by(|a, b| a.directory.cmp(&b.directory));
    Ok(out)
}

/// 在远端将技能目录复制到 SSOT → 更新 skills.json → 创建 symlink。
pub async fn import_remote_skill_local<F: FileOps>(
    fs: &F,
    channel: &russh::client::Handle<crate::remote::connection::RemoteHandler>,
    container: Option<&str>,
    root: &str,
    source_path: &str,
    name: &str,
    apps: &RemoteSkillApps,
    use_copy: bool,
) -> Result<RemoteSkillRecord, String> {
    let ssot_dir = remote_ssot_path(root);
    let dest = format!("{ssot_dir}/{name}");

    // cp -r 源到 SSOT
    if container.is_some() {
        // 容器：通过 docker cp 或 base64 方式
        crate::remote::docker::copy_dir_to_container(channel, container.unwrap(), source_path, &dest).await?;
    } else {
        // 宿主机：exec cp -r
        let cp_cmd = format!("cp -r {} {}", shell_q(source_path), shell_q(&dest));
        crate::remote::connection::exec_command(channel, &cp_cmd).await?;
    }

    // 读取 SKILL.md 获取元数据
    let (display_name, description) = read_skill_md_meta_static(fs, &dest).await;

    let now = chrono::Utc::now().timestamp_millis();
    let record = RemoteSkillRecord {
        id: uuid::Uuid::new_v4().to_string(),
        name: display_name.unwrap_or_else(|| name.to_string()),
        description,
        directory: name.to_string(),
        apps: apps.clone(),
        installed_at: now,
        updated_at: now,
        repo_owner: None,
        repo_name: None,
        repo_branch: None,
        readme_url: None,
        content_hash: None,
    };

    // 更新 skills.json
    let mut records = read_remote_skills_json(fs, root).await?;
    records.retain(|r| r.directory != name);
    records.push(record.clone());
    write_remote_skills_json(fs, root, &records).await?;

    // 创建链接（symlink 或 copy，取决于设置）
    sync_remote_skill_links(channel, container, root, name, apps, use_copy).await?;

    Ok(record)
}

// ========================================================================
// ZIP 安装
// ========================================================================

/// 将本地目录递归上传到远端目标目录（`remote_dir` 作为根被创建）。
pub(crate) async fn upload_dir_to_remote(
    sftp: &SftpSession,
    local_dir: &Path,
    remote_dir: &str,
) -> Result<(), String> {
    ensure_remote_dir(sftp, remote_dir).await?;

    let mut remote_dirs: Vec<String> = Vec::new();
    collect_dirs_recursive(local_dir, remote_dir, &mut remote_dirs)?;
    for dir in remote_dirs.iter().rev() {
        ensure_remote_dir(sftp, dir).await?;
    }

    let mut local_files: Vec<(std::path::PathBuf, String)> = Vec::new();
    collect_files_recursive(local_dir, remote_dir, &mut local_files)?;
    for (local_path, remote_path) in local_files {
        let data = std::fs::read(&local_path)
            .map_err(|e| format!("读取本地文件失败 {}: {e}", local_path.display()))?;
        let mut file = sftp
            .create(&remote_path)
            .await
            .map_err(|e| format!("远端创建文件失败 {remote_path}: {e}"))?;
        use tokio::io::AsyncWriteExt;
        file.write_all(&data)
            .await
            .map_err(|e| format!("远端写入文件失败 {remote_path}: {e}"))?;
        file.flush()
            .await
            .map_err(|e| format!("远端刷新文件失败 {remote_path}: {e}"))?;
    }
    Ok(())
}

pub(crate) fn collect_dirs_recursive(
    local_dir: &Path,
    remote_dir: &str,
    out: &mut Vec<String>,
) -> Result<(), String> {
    let entries = std::fs::read_dir(local_dir)
        .map_err(|e| format!("读取本地目录失败 {}: {e}", local_dir.display()))?;
    for entry in entries.flatten() {
        let local_path = entry.path();
        if local_path.is_dir() {
            let name = entry.file_name().to_string_lossy().to_string();
            let sub = format!("{remote_dir}/{name}");
            out.push(sub.clone());
            collect_dirs_recursive(&local_path, &sub, out)?;
        }
    }
    Ok(())
}

pub(crate) fn collect_files_recursive(
    local_dir: &Path,
    remote_dir: &str,
    out: &mut Vec<(std::path::PathBuf, String)>,
) -> Result<(), String> {
    let entries = std::fs::read_dir(local_dir)
        .map_err(|e| format!("读取本地目录失败 {}: {e}", local_dir.display()))?;
    for entry in entries.flatten() {
        let local_path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if local_path.is_dir() {
            collect_files_recursive(&local_path, &format!("{remote_dir}/{name}"), out)?;
        } else {
            out.push((local_path, format!("{remote_dir}/{name}")));
        }
    }
    Ok(())
}

pub async fn install_remote_skills_from_zip(
    sftp: &SftpSession,
    root: &str,
    zip_path: &str,
) -> Result<Vec<String>, String> {
    use crate::services::skill::SkillService;

    let zip_path = Path::new(zip_path);
    let temp_guard = SkillService::extract_local_zip(zip_path)
        .map_err(|e| format!("解压 ZIP 失败: {e}"))?;
    let temp_dir = temp_guard.path().to_path_buf();

    let skill_dirs = SkillService::scan_skills_in_dir(&temp_dir)
        .map_err(|e| format!("扫描 ZIP 内技能失败: {e}"))?;
    if skill_dirs.is_empty() {
        return Err("ZIP 内未找到含 SKILL.md 的技能目录".to_string());
    }

    let zip_stem = zip_path
        .file_stem()
        .and_then(|s| s.to_str())
        .map(|s| s.to_string());

    let ssot_dir = remote_ssot_path(root);
    let mut installed: Vec<String> = Vec::new();
    let fs = crate::fsops::RemoteSftpFileOps { sftp };
    let records = read_remote_skills_json(&fs, root).await?;
    let existing: std::collections::HashSet<String> =
        records.iter().map(|r| r.directory.clone()).collect();

    for skill_dir in &skill_dirs {
        let dir_name = skill_dir
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        let install_name = if skill_dir == &temp_dir
            || dir_name.is_empty()
            || dir_name.starts_with('.')
        {
            zip_stem
                .as_deref()
                .map(|s| sanitize_name(s))
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "skill".to_string())
        } else {
            sanitize_name(&dir_name)
        };
        if install_name.is_empty() {
            continue;
        }
        if existing.contains(&install_name) {
            log::warn!("[remote] 远端已存在技能目录 {install_name}，跳过");
            continue;
        }

        let remote_dir = format!("{ssot_dir}/{install_name}");
        upload_dir_to_remote(sftp, skill_dir, &remote_dir).await?;
        installed.push(install_name);
    }

    if installed.is_empty() {
        return Err("没有可安装的新技能（可能远端已全部存在）".to_string());
    }
    Ok(installed)
}

pub async fn install_remote_skills_from_zip_generic(
    sftp: &SftpSession,
    channel: &russh::client::Handle<crate::remote::connection::RemoteHandler>,
    container: Option<&str>,
    root: &str,
    zip_path: &str,
) -> Result<Vec<String>, String> {
    use crate::services::skill::SkillService;

    let zip_path = Path::new(zip_path);
    let temp_guard = SkillService::extract_local_zip(zip_path)
        .map_err(|e| format!("解压 ZIP 失败: {e}"))?;
    let temp_dir = temp_guard.path().to_path_buf();

    let skill_dirs = SkillService::scan_skills_in_dir(&temp_dir)
        .map_err(|e| format!("扫描 ZIP 内技能失败: {e}"))?;
    if skill_dirs.is_empty() {
        return Err("ZIP 内未找到含 SKILL.md 的技能目录".to_string());
    }

    let zip_stem = zip_path
        .file_stem()
        .and_then(|s| s.to_str())
        .map(|s| s.to_string());

    let ssot_dir = remote_ssot_path(root);
    let mut installed: Vec<String> = Vec::new();
    let target = crate::remote::docker::RemoteTarget::new(sftp, channel, container)?;
    let records = read_remote_skills_json(&target, root).await?;
    let existing: std::collections::HashSet<String> =
        records.iter().map(|r| r.directory.clone()).collect();

    for skill_dir in &skill_dirs {
        let dir_name = skill_dir
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        let install_name = if skill_dir == &temp_dir
            || dir_name.is_empty()
            || dir_name.starts_with('.')
        {
            zip_stem
                .as_deref()
                .map(|s| sanitize_name(s))
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "skill".to_string())
        } else {
            sanitize_name(&dir_name)
        };
        if install_name.is_empty() {
            continue;
        }
        if existing.contains(&install_name) {
            log::warn!("[remote] 远端已存在技能目录 {install_name}，跳过");
            continue;
        }

        let remote_dir = format!("{ssot_dir}/{install_name}");
        if let Some(c) = container {
            crate::remote::docker::upload_dir_to_container(channel, c, skill_dir, &remote_dir)
                .await?;
        } else {
            upload_dir_to_remote(sftp, skill_dir, &remote_dir).await?;
        }
        installed.push(install_name);
    }

    if installed.is_empty() {
        return Err("没有可安装的新技能（可能远端已全部存在）".to_string());
    }
    Ok(installed)
}

pub(crate) fn sanitize_name(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty()
        || trimmed.contains('/')
        || trimmed.contains('\\')
        || trimmed == "."
        || trimmed == ".."
    {
        return String::new();
    }
    trimmed.to_string()
}

// ========================================================================
// 内部辅助
// ========================================================================

pub(crate) async fn read_skill_md_meta_static<F: FileOps>(
    fs: &F,
    skill_dir: &str,
) -> (Option<String>, Option<String>) {
    let md_path = format!("{skill_dir}/SKILL.md");
    let content = match fs.read_text_optional(&md_path).await {
        Ok(Some(text)) => text,
        Ok(None) => {
            log::warn!("[remote-skill] SKILL.md 不存在: {md_path}");
            return (None, None);
        }
        Err(e) => {
            log::warn!("[remote-skill] 读取 SKILL.md 失败: {md_path}: {e}");
            return (None, None);
        }
    };
    let content = content.trim_start_matches('\u{feff}');
    let parts: Vec<&str> = content.splitn(3, "---").collect();
    if parts.len() < 3 {
        log::warn!("[remote-skill] SKILL.md 无 YAML frontmatter: {md_path} (parts={})", parts.len());
        return (None, None);
    }
    let front_matter = parts[1].trim();
    let meta: serde_json::Value = match serde_yaml::from_str(front_matter) {
        Ok(v) => v,
        Err(e) => {
            log::warn!("[remote-skill] SKILL.md YAML 解析失败: {md_path}: {e}");
            return (None, None);
        }
    };
    let name = meta
        .get("name")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let description = meta
        .get("description")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    log::info!("[remote-skill] parsed {md_path}: name={name:?} desc={description:?}");
    (name, description)
}

fn shell_q(s: &str) -> String {
    if s.contains('\'') {
        format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
    } else {
        format!("'{s}'")
    }
}

async fn exec_cmd(
    channel: &russh::client::Handle<crate::remote::connection::RemoteHandler>,
    container: Option<&str>,
    cmd: &str,
) -> Result<String, String> {
    let full = match container {
        Some(c) => format!("docker exec {} sh -c {}", c, shell_q(cmd)),
        None => cmd.to_string(),
    };
    crate::remote::connection::exec_command(channel, &full).await
}
