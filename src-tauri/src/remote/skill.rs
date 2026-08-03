//! 远端 Skills 目录管理。
//!
//! 选中远端目标时，Skills 面板管理该主机 `~/.claude/skills/` 下的已安装技能。
//! 通过 `FileOps` 接口支持三种数据源：本机（std::fs）/ 宿主机（SFTP）/ 容器内（docker exec）。
//!
//! 边界说明：**列出 / 删除**走泛型 `FileOps`（三种目标通用）；**从 ZIP 安装**需要
//! 大量二进制写文件，仅宿主机（SFTP）支持，容器内暂不支持（返回明确错误）。

use std::path::Path;

use russh_sftp::client::SftpSession;
use serde::Serialize;
use tokio::io::AsyncWriteExt;

use crate::fsops::FileOps;

use super::sftp_io::ensure_remote_dir;

/// 远端技能目录项。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSkillEntry {
    /// 技能目录名（唯一标识）。
    pub name: String,
    pub path: String,
    /// 从 SKILL.md frontmatter 解析的显示名；无则回退为目录名。
    pub display_name: Option<String>,
    /// 从 SKILL.md frontmatter 解析的描述。
    pub description: Option<String>,
}

/// 远端 `~/.claude/skills` 目录路径（`root` 为家目录）。
pub fn remote_skills_path(root: &str) -> String {
    format!("{root}/.claude/skills")
}

/// 列出远端 `~/.claude/skills/` 下的子目录（每个 = 一个已安装技能）。
/// 对每个技能目录读取 `SKILL.md` 的 YAML frontmatter，解析出显示名与描述。
/// 目录不存在时返回空列表。
pub async fn list_remote_skills<F: FileOps>(
    fs: &F,
    root: &str,
) -> Result<Vec<RemoteSkillEntry>, String> {
    let path = remote_skills_path(root);
    if !fs.exists(&path).await {
        return Ok(Vec::new());
    }
    let dir = fs
        .read_dir(&path)
        .await
        .map_err(|e| format!("读取远端技能目录失败 {path}: {e}"))?;

    let mut out = Vec::new();
    for entry in dir {
        if !entry.is_dir {
            continue;
        }
        let dir_name = entry.name;
        let (display_name, description) = read_remote_skill_md_meta(fs, &entry.path).await;
        out.push(RemoteSkillEntry {
            display_name: display_name.filter(|n| !n.is_empty()).or_else(|| {
                Some(dir_name.clone())
            }),
            description,
            name: dir_name,
            path: entry.path,
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

/// 读取远端技能目录的 `SKILL.md`，解析 YAML frontmatter 的 `name` / `description`。
/// 文件缺失 / 解析失败时返回 `(None, None)`（调用方回退目录名）。
async fn read_remote_skill_md_meta<F: FileOps>(
    fs: &F,
    skill_dir: &str,
) -> (Option<String>, Option<String>) {
    let md_path = format!("{skill_dir}/SKILL.md");
    let content = match fs.read_text_optional(&md_path).await {
        Ok(Some(text)) => text,
        _ => return (None, None),
    };

    // 与本机 parse_skill_metadata_static 一致：以 `---` 分隔的 YAML frontmatter
    let content = content.trim_start_matches('\u{feff}');
    let parts: Vec<&str> = content.splitn(3, "---").collect();
    if parts.len() < 3 {
        return (None, None);
    }
    let front_matter = parts[1].trim();
    let meta: serde_json::Value = match serde_yaml::from_str(front_matter) {
        Ok(v) => v,
        Err(_) => return (None, None),
    };
    let name = meta
        .get("name")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let description = meta
        .get("description")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    (name, description)
}

/// 删除远端 `~/.claude/skills/` 下的一个技能目录（递归）。
pub async fn delete_remote_skill<F: FileOps>(
    fs: &F,
    root: &str,
    name: &str,
) -> Result<bool, String> {
    if name.is_empty() || name.contains('/') || name.contains('\\') || name == "." || name == ".." {
        return Err("非法技能名称".to_string());
    }
    let path = format!("{}/{}", remote_skills_path(root), name);
    if !fs.exists(&path).await {
        return Ok(false);
    }
    if !fs.is_dir(&path).await {
        return Err(format!("{name} 不是技能目录"));
    }
    fs.remove_dir_all(&path).await?;
    Ok(true)
}

// ========================================================================
// 从本地 ZIP 安装（仅宿主机 SFTP）
// ========================================================================

/// 将本地目录递归上传到远端目标目录（`remote_dir` 会作为根被创建）。
///
/// 通过 SFTP 逐级 mkdir + 写文件（支持二进制文件如 .docx）；symlink 直接跳过
/// （远端按普通文件落盘，避免把本地符号链接语义带到远端引发安全/一致性隐患）。
async fn upload_dir_to_remote(
    sftp: &SftpSession,
    local_dir: &Path,
    remote_dir: &str,
) -> Result<(), String> {
    ensure_remote_dir(sftp, remote_dir).await?;

    // 第一遍：递归创建远端目录结构（sftp.create 不会自动建父目录）
    let mut remote_dirs: Vec<String> = Vec::new();
    collect_dirs_recursive(local_dir, remote_dir, &mut remote_dirs)?;
    for dir in remote_dirs.iter().rev() {
        ensure_remote_dir(sftp, dir).await?;
    }

    // 第二遍：递归收集普通文件并写入
    let mut local_files: Vec<(std::path::PathBuf, String)> = Vec::new();
    collect_files_recursive(local_dir, remote_dir, &mut local_files)?;
    for (local_path, remote_path) in local_files {
        let data = std::fs::read(&local_path)
            .map_err(|e| format!("读取本地文件失败 {}: {e}", local_path.display()))?;
        let mut file = sftp
            .create(&remote_path)
            .await
            .map_err(|e| format!("远端创建文件失败 {remote_path}: {e}"))?;
        file.write_all(&data)
            .await
            .map_err(|e| format!("远端写入文件失败 {remote_path}: {e}"))?;
        file.flush()
            .await
            .map_err(|e| format!("远端刷新文件失败 {remote_path}: {e}"))?;
    }
    Ok(())
}

/// 递归收集本地目录下所有**子目录**的远端路径（不含根 `remote_dir` 本身）。
fn collect_dirs_recursive(
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

/// 递归收集本地目录下所有普通文件，映射为 `(本地路径, 远端路径)`。
fn collect_files_recursive(
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

/// 从本地 ZIP 安装技能到远端 `~/.claude/skills/`（仅宿主机 SFTP）。
///
/// 复用本机 SkillService 的解压 + 扫描逻辑（含 zip 炸弹预算、symlink 解析、
/// `..` 路径防护），对每个含 SKILL.md 的技能目录确定安装名并递归上传到远端。
/// 返回实际安装的技能目录名列表。
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

    let skills_root = remote_skills_path(root);
    let mut installed: Vec<String> = Vec::new();
    let existing: std::collections::HashSet<String> = {
        let fs = crate::fsops::RemoteSftpFileOps { sftp };
        let entries = list_remote_skills(&fs, root).await?;
        entries.into_iter().map(|e| e.name).collect()
    };

    for skill_dir in &skill_dirs {
        let dir_name = skill_dir
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        // 安装名与 zip 根目录（temp_dir）对齐时用 zip 文件名兜底
        let install_name = if skill_dir == &temp_dir || dir_name.is_empty() || dir_name.starts_with('.')
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
            log::warn!("[remote] 远端已存在技能目录 {install_name}，跳过（如需覆盖请先删除）");
            continue;
        }

        let remote_dir = format!("{skills_root}/{install_name}");
        upload_dir_to_remote(sftp, skill_dir, &remote_dir).await?;
        installed.push(install_name);
    }

    if installed.is_empty() {
        return Err("没有可安装的新技能（可能远端已全部存在）".to_string());
    }
    Ok(installed)
}

/// 技能目录名清理：拒绝分隔符 / 隐藏目录，避免路径穿越。
fn sanitize_name(raw: &str) -> String {
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
