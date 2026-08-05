//! Tauri 命令层：前端通过 `invoke` 调用远程主机管理功能。
//!
//! 注意：命令需要在 `lib.rs` 的 `invoke_handler` 中注册。

use serde_json::{json, Value};
use tauri::State;

use crate::fsops::FileOps as _;
use crate::remote::effect::EffectReport;
use crate::remote::settings;
use crate::remote::{connection, credentials, AuthMethod, RemoteHost};
use crate::store::AppState;

/// 主机信息（给前端的列表项；不含密码）。
#[tauri::command]
pub async fn list_remote_hosts(state: State<'_, AppState>) -> Result<Vec<RemoteHost>, String> {
    state.db.list_remote_hosts().map_err(|e| e.to_string())
}

/// 保存（新增或更新）远程主机；可选携带密码并写入系统钥匙串。
#[tauri::command]
pub async fn save_remote_host(
    state: State<'_, AppState>,
    host: RemoteHost,
    password: Option<String>,
) -> Result<RemoteHost, String> {
    let mut host = host;
    if host.id.trim().is_empty() {
        host.id = uuid::Uuid::new_v4().to_string();
    }
    let now = chrono::Utc::now().timestamp_millis();
    if host.created_at <= 0 {
        host.created_at = now;
    }
    host.updated_at = now;

    state
        .db
        .upsert_remote_host(&host)
        .map_err(|e| e.to_string())?;

    // 只要提供了密码，就无条件写入系统钥匙串，保证连接/切换可用。
    // save_password 仅作为「记住密码」的偏好标记；若用户刻意留空密码则不覆盖旧密码。
    if let Some(pw) = password.as_deref().filter(|p| !p.is_empty()) {
        log::info!("[remote] 保存密码到钥匙串 id={}", host.id);
        if let Err(e) = credentials::save_password(&host.id, pw) {
            log::error!("[remote] 钥匙串保存失败: {e}");
            return Err(e);
        }
        log::info!("[remote] 钥匙串保存成功 id={}", host.id);
    } else if !host.save_password {
        // 用户关闭了「保存密码」且未提供新密码 → 删除钥匙串里的已存密码。
        log::info!("[remote] 删除钥匙串密码 id={}", host.id);
        let _ = credentials::delete_password(&host.id);
    }
    Ok(host)
}

/// 删除远程主机（同时清除系统钥匙串里的密码）。
#[tauri::command]
pub async fn delete_remote_host(
    state: State<'_, AppState>,
    host_id: String,
) -> Result<bool, String> {
    let deleted = state
        .db
        .delete_remote_host(&host_id)
        .map_err(|e| e.to_string())?;
    if deleted {
        let _ = credentials::delete_password(&host_id);
        let _ = crate::remote::current::delete_current_provider(&host_id);
    }
    Ok(deleted)
}

/// 测试与远程主机的连接（认证 + SFTP 初始化），并探测远端配置是否存在。
#[tauri::command]
pub async fn test_remote_connection(
    state: State<'_, AppState>,
    host_id: String,
    container: Option<String>,
) -> Result<serde_json::Value, String> {
    let host = load_host(&state, &host_id)?;
    let password = resolve_password(&host)?;
    probe_remote(&host, &password, container.as_deref()).await
}

/// 用「未保存的连接信息」直接测试 SSH 连接（新增主机场景，不需要先保存）。
#[tauri::command]
pub async fn test_remote_connection_info(
    host: String,
    port: u16,
    username: String,
    password: String,
) -> Result<serde_json::Value, String> {
    let host_info = RemoteHost {
        id: "temp".to_string(),
        name: username.clone(),
        host,
        port,
        username,
        auth_method: AuthMethod::Password,
        save_password: false,
        created_at: 0,
        updated_at: 0,
    };
    probe_remote(&host_info, &password, None).await
}

/// 共享探测逻辑：建连 + 探测远端 settings 是否存在 + 检测 Claude Code 安装。
async fn probe_remote(
    host: &RemoteHost,
    password: &str,
    container: Option<&str>,
) -> Result<serde_json::Value, String> {
    let session = connection::connect(host, Some(password)).await?;
    let home = host.default_home();
    let target = crate::remote::docker::RemoteTarget::new(
        &session.sftp,
        &session.channel,
        container,
    )?;
    let settings_path = settings::remote_settings_path(&home);
    let settings_exists = target.exists(&settings_path).await;

    // 通过 exec 通道检测是否安装 Claude Code（命中哨兵 = 已安装）
    let claude_cmd = claude_installed_probe(container);
    let claude_installed = match connection::exec_command(&session.channel, &claude_cmd).await {
        Ok(out) => {
            // Info 级：默认日志等级可记录，用于确认探测命令的真实返回
            log::info!(
                "[remote] claude 探测 cmd={claude_cmd:?} out={out:?} found={}",
                out.contains(CLAUDE_INSTALLED_MARKER)
            );
            Some(out.contains(CLAUDE_INSTALLED_MARKER))
        }
        Err(e) => {
            log::warn!("[remote] 检测 claude 安装状态失败: {e}");
            None
        }
    };

    Ok(json!({
        "connected": true,
        "home": home,
        "settingsExists": settings_exists,
        "claudeCodeInstalled": claude_installed,
    }))
}

/// 读取远端 `~/.claude/settings.json`（原始 JSON，供前端展示/编辑）。
/// `container` 为 Some 时读取容器内路径。
#[tauri::command]
pub async fn read_remote_settings(
    state: State<'_, AppState>,
    host_id: String,
    container: Option<String>,
) -> Result<serde_json::Value, String> {
    let host = load_host(&state, &host_id)?;
    let password = resolve_password(&host)?;

    let session = connection::connect(&host, Some(&password)).await?;
    let target = crate::remote::docker::RemoteTarget::new(
        &session.sftp,
        &session.channel,
        container.as_deref(),
    )?;
    settings::read_remote_settings(&target, &host.default_home()).await
}

/// 对远程主机执行供应商切换：将本地供应商的 env 块原子写回远端 settings.json，
/// 返回「生效方式」报告。
#[tauri::command]
pub async fn switch_remote_provider(
    state: State<'_, AppState>,
    host_id: String,
    provider_id: String,
    container: Option<String>,
) -> Result<EffectReport, String> {
    let host = load_host(&state, &host_id)?;
    let password = resolve_password(&host)?;

    // 加载 Claude 供应商（远程切换当前只针对 Claude Code）
    let providers = state
        .db
        .get_all_providers("claude")
        .map_err(|e| e.to_string())?;
    let provider = providers
        .get(&provider_id)
        .ok_or_else(|| "供应商不存在，可能已被删除".to_string())?;

    // 复用本机切换的构建逻辑：provider env + 通用配置片段 + 供应商默认值，
    // 保证远端产出的 settings.json 与本机「启用」完全一致。
    let effective =
        crate::services::provider::live::build_effective_settings_with_common_config(
            &state.db,
            &crate::app_config::AppType::Claude,
            provider,
        )
        .map_err(|e| e.to_string())?;
    // 与本机 write_live_snapshot 一致：剔除内部字段
    let sanitized =
        crate::services::provider::live::sanitize_claude_settings_for_live(&effective);

    let session = connection::connect(&host, Some(&password)).await?;
    let target = crate::remote::docker::RemoteTarget::new(
        &session.sftp,
        &session.channel,
        container.as_deref(),
    )?;
    let report = settings::apply_provider_settings(
        &target,
        &host.default_home(),
        &host.name,
        &provider.name,
        &sanitized,
    )
    .await?;

    // 切换成功即持久化「该远端当前生效供应商」。与原生 cc switch 的「当前供应商」
    // 语义一致（判断当前不靠 base_url 匹配），这样编辑该供应商时能可靠判定需要写回远端。
    if let Err(e) = crate::remote::current::save_current_provider(&host_id, &provider_id) {
        log::warn!("[remote] 持久化当前供应商失败 host_id={host_id}: {e}");
    }

    Ok(report)
}

/// 扫描远端 shell 配置中的冲突环境变量（ANTHROPIC_* 名单）。
#[tauri::command]
pub async fn scan_remote_env_conflicts(
    state: State<'_, AppState>,
    host_id: String,
    container: Option<String>,
) -> Result<Vec<crate::remote::env_clean::RemoteEnvConflict>, String> {
    let host = load_host(&state, &host_id)?;
    let password = resolve_password(&host)?;
    let session = connection::connect(&host, Some(&password)).await?;
    let target = crate::remote::docker::RemoteTarget::new(
        &session.sftp,
        &session.channel,
        container.as_deref(),
    )?;
    crate::remote::env_clean::scan_remote_env_conflicts(&target, &host.default_home()).await
}

/// 读取远端「当前生效」的本地供应商 id。
///
/// 优先返回本应用切换时持久化的记录（`~/.cc-switch/remote_current_providers.json`，
/// 与原生 cc switch 的「当前供应商」语义一致、不依赖 base_url 匹配）；
/// 持久化缺失（如该供应商从未经本应用切换过、或记录被清理）时，才连 SSH 读远端
/// settings.json 按 ANTHROPIC_BASE_URL 兜底匹配。
///
/// 用于目标选择器：选中服务器后，主界面供应商列表的当前高亮取自远端。
#[tauri::command]
pub async fn get_remote_current_provider(
    state: State<'_, AppState>,
    host_id: String,
    container: Option<String>,
) -> Result<Option<String>, String> {
    let host = load_host(&state, &host_id)?;

    // 1) 持久化记录优先：这是本应用上次「切换」写入的真实当前供应商，
    //    不受用户后续编辑 base_url / 通用配置片段影响（那正是匹配法失效的场景）。
    if let Some(persisted) = crate::remote::current::get_current_provider(&host_id)? {
        if state
            .db
            .get_provider_by_id(&persisted, "claude")
            .map_err(|e| e.to_string())?
            .is_some()
        {
            return Ok(Some(persisted));
        }
    }

    // 2) 兜底：读目标（宿主机/容器）settings.json 匹配 base_url（对从未经本应用切换的老配置）。
    let password = resolve_password(&host)?;
    let session = connection::connect(&host, Some(&password)).await?;
    let target = crate::remote::docker::RemoteTarget::new(
        &session.sftp,
        &session.channel,
        container.as_deref(),
    )?;
    let settings = settings::read_remote_settings(&target, &host.default_home()).await?;

    let remote_base = settings
        .pointer("/env/ANTHROPIC_BASE_URL")
        .and_then(Value::as_str)
        .unwrap_or("");

    let providers = state
        .db
        .get_all_providers("claude")
        .map_err(|e| e.to_string())?;
    for (id, p) in &providers {
        // 远端 settings.json 里存的是「生效配置」——即合并通用配置片段后的结果，
        // 与 switch_remote_provider 写入时一致。因此这里必须用同一份生效配置的
        // base_url 去比对，否则开启了通用配置的供应商永远匹配不上，编辑推送会被跳过。
        let effective = crate::services::provider::live::build_effective_settings_with_common_config(
            &state.db,
            &crate::app_config::AppType::Claude,
            p,
        )
        .map_err(|e| e.to_string())?;
        let local_base = effective
            .pointer("/env/ANTHROPIC_BASE_URL")
            .and_then(Value::as_str)
            .unwrap_or("");
        if !local_base.is_empty() && local_base == remote_base {
            return Ok(Some(id.clone()));
        }
    }
    Ok(None)
}

/// 检测本机是否安装 Claude Code（`where claude` / `command -v claude`）。
#[tauri::command]
pub fn check_local_claude_installed() -> Result<bool, String> {
    #[cfg(target_os = "windows")]
    let found = std::process::Command::new("where")
        .arg("claude")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);

    #[cfg(not(target_os = "windows"))]
    let found = std::process::Command::new("sh")
        .arg("-c")
        .arg("command -v claude")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);

    Ok(found)
}

/// 检测远端是否安装 Claude Code（`command -v claude`），带超时。
/// 返回 true=已安装 / false=未安装 / None=检测失败或超时。
#[tauri::command]
pub async fn check_remote_claude_installed(
    state: State<'_, AppState>,
    host_id: String,
    container: Option<String>,
) -> Result<Option<bool>, String> {
    let host = load_host(&state, &host_id)?;
    let password = resolve_password(&host)?;

    let claude_cmd = claude_installed_probe(container.as_deref());
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(15),
        async move {
            let session = connection::connect(&host, Some(&password)).await?;
            match connection::exec_command(&session.channel, &claude_cmd).await {
                Ok(out) => {
                    // Info 级：默认日志等级可记录，用于确认探测命令的真实返回
                    log::info!(
                        "[remote] claude 探测 cmd={claude_cmd:?} out={out:?} found={}",
                        out.contains(CLAUDE_INSTALLED_MARKER)
                    );
                    Ok(Some(out.contains(CLAUDE_INSTALLED_MARKER)))
                }
                Err(e) => {
                    log::warn!("[remote] 检测远端 claude 安装状态失败: {e}");
                    Ok(None)
                }
            }
        },
    )
    .await;

    match result {
        Ok(r) => r,
        Err(_) => {
            log::warn!("[remote] 检测远端 claude 安装状态超时 host_id={host_id}");
            Ok(None)
        }
    }
}

/// 列出远端 `~/.claude/projects/` 下的会话 jsonl 文件。
#[tauri::command]
pub async fn list_remote_sessions(
    state: State<'_, AppState>,
    host_id: String,
    container: Option<String>,
) -> Result<Vec<crate::remote::sessions::RemoteSessionInfo>, String> {
    let host = load_host(&state, &host_id)?;
    let password = resolve_password(&host)?;
    let session = connection::connect(&host, Some(&password)).await?;
    let target = crate::remote::docker::RemoteTarget::new(
        &session.sftp,
        &session.channel,
        container.as_deref(),
    )?;
    crate::remote::sessions::list_remote_sessions(&target, &host.default_home()).await
}

/// 复用本机 `session_manager` 的解析逻辑，列出远端会话的**完整元数据**（标题/摘要/时间等）。
/// 通过 `FileOps` + 共享的 `scan_sessions_fs` 实现「一套逻辑、本机/远端/容器三套数据源」。
#[tauri::command]
pub async fn list_remote_sessions_detailed(
    state: State<'_, AppState>,
    host_id: String,
    container: Option<String>,
) -> Result<Vec<crate::session_manager::SessionMeta>, String> {
    let host = load_host(&state, &host_id)?;
    let password = resolve_password(&host)?;
    let session = connection::connect(&host, Some(&password)).await?;
    let target = crate::remote::docker::RemoteTarget::new(
        &session.sftp,
        &session.channel,
        container.as_deref(),
    )?;
    let home = host.default_home();
    let root = format!("{home}/.claude/projects");
    Ok(crate::session_manager::providers::claude::scan_sessions_fs(&target, &root).await)
}

/// 读取远端会话消息（复用本机 `parse_messages_from_lines` 纯解析）。
#[tauri::command]
pub async fn get_remote_session_messages(
    state: State<'_, AppState>,
    host_id: String,
    source_path: String,
    container: Option<String>,
) -> Result<Vec<crate::session_manager::SessionMessage>, String> {
    let host = load_host(&state, &host_id)?;
    let password = resolve_password(&host)?;
    let session = connection::connect(&host, Some(&password)).await?;
    let target = crate::remote::docker::RemoteTarget::new(
        &session.sftp,
        &session.channel,
        container.as_deref(),
    )?;
    let content = target
        .read_text_optional(&source_path)
        .await?
        .unwrap_or_default();
    Ok(crate::session_manager::providers::claude::parse_messages_from_lines(
        content.lines().map(|s| s.to_string()),
    ))
}

/// 删除远端会话（主文件 + sidecar 目录），通过 FileOps 实现。
#[tauri::command]
pub async fn delete_remote_session(
    state: State<'_, AppState>,
    host_id: String,
    source_path: String,
    session_id: String,
    container: Option<String>,
) -> Result<bool, String> {
    let host = load_host(&state, &host_id)?;
    let password = resolve_password(&host)?;
    let session = connection::connect(&host, Some(&password)).await?;
    let target = crate::remote::docker::RemoteTarget::new(
        &session.sftp,
        &session.channel,
        container.as_deref(),
    )?;

    // 校验 session_id 与远端文件匹配（复用本机解析）
    let (head, tail) = target.read_head_tail_lines(&source_path, 10, 30).await?;
    let meta = crate::session_manager::providers::claude::parse_session_meta_from_lines(
        &source_path,
        &head,
        &tail,
    )
    .ok_or_else(|| format!("无法解析远端会话元数据: {source_path}"))?;
    if meta.session_id != session_id {
        return Err(format!(
            "会话 ID 不匹配: 期望 {session_id}, 实际 {}",
            meta.session_id
        ));
    }

    // 删除主文件 + sidecar 目录（同名无 .jsonl 后缀）
    let sidecar = source_path
        .strip_suffix(".jsonl")
        .unwrap_or(&source_path)
        .to_string();
    if target.exists(&sidecar).await {
        if target.is_dir(&sidecar).await {
            target.remove_dir_all(&sidecar).await?;
        } else {
            target.remove_file(&sidecar).await?;
        }
    }
    target.remove_file(&source_path).await?;
    Ok(true)
}

/// 列出远端 MCP 服务器（完整 McpServer，读 SSOT ~/.cc-switch/mcp.json）。
#[tauri::command]
pub async fn read_remote_mcp_servers(
    state: State<'_, AppState>,
    host_id: String,
    container: Option<String>,
) -> Result<Vec<crate::remote::mcp::RemoteMcpServer>, String> {
    let host = load_host(&state, &host_id)?;
    let password = resolve_password(&host)?;
    let session = connection::connect(&host, Some(&password)).await?;
    let target = crate::remote::docker::RemoteTarget::new(
        &session.sftp,
        &session.channel,
        container.as_deref(),
    )?;
    crate::remote::mcp::list_remote_mcp_servers(&target, &host.default_home()).await
}

/// 读取远端 `~/.claude.json` 的**完整内容**（供编辑/展示）。
#[tauri::command]
pub async fn read_remote_mcp_json(
    state: State<'_, AppState>,
    host_id: String,
    container: Option<String>,
) -> Result<serde_json::Value, String> {
    let host = load_host(&state, &host_id)?;
    let password = resolve_password(&host)?;
    let session = connection::connect(&host, Some(&password)).await?;
    let target = crate::remote::docker::RemoteTarget::new(
        &session.sftp,
        &session.channel,
        container.as_deref(),
    )?;
    crate::remote::mcp::read_remote_mcp_json(&target, &host.default_home()).await
}

/// 新增/更新远端 MCP 服务器：写 SSOT + 同步 apps 启用的各 live 配置。
#[tauri::command]
pub async fn upsert_remote_mcp_server(
    state: State<'_, AppState>,
    host_id: String,
    server: crate::remote::mcp::RemoteMcpServer,
    container: Option<String>,
) -> Result<bool, String> {
    let host = load_host(&state, &host_id)?;
    let password = resolve_password(&host)?;
    let session = connection::connect(&host, Some(&password)).await?;
    let target = crate::remote::docker::RemoteTarget::new(
        &session.sftp,
        &session.channel,
        container.as_deref(),
    )?;
    crate::remote::mcp::upsert_remote_mcp_server(&target, &host.default_home(), &server).await?;
    Ok(true)
}

/// 从远端删除一个 MCP 服务器：删 SSOT + 从所有启用的 live 配置移除。
#[tauri::command]
pub async fn delete_remote_mcp_server(
    state: State<'_, AppState>,
    host_id: String,
    id: String,
    container: Option<String>,
) -> Result<bool, String> {
    let host = load_host(&state, &host_id)?;
    let password = resolve_password(&host)?;
    let session = connection::connect(&host, Some(&password)).await?;
    let target = crate::remote::docker::RemoteTarget::new(
        &session.sftp,
        &session.channel,
        container.as_deref(),
    )?;
    crate::remote::mcp::delete_remote_mcp_server(&target, &host.default_home(), &id).await
}

/// 切换远端 MCP 服务器在指定 app 的启用状态（改 SSOT + 同步/移除该 app live）。
#[tauri::command]
pub async fn toggle_remote_mcp_app(
    state: State<'_, AppState>,
    host_id: String,
    id: String,
    app: String,
    enabled: bool,
    container: Option<String>,
) -> Result<bool, String> {
    let host = load_host(&state, &host_id)?;
    let password = resolve_password(&host)?;
    let session = connection::connect(&host, Some(&password)).await?;
    let target = crate::remote::docker::RemoteTarget::new(
        &session.sftp,
        &session.channel,
        container.as_deref(),
    )?;
    crate::remote::mcp::toggle_remote_mcp_app(
        &target,
        &host.default_home(),
        &id,
        &app,
        enabled,
    )
    .await?;
    Ok(true)
}

/// 从远端各 CLI live 配置导入 MCP 到 SSOT，返回新导入数量。
#[tauri::command]
pub async fn import_remote_mcp_from_apps(
    state: State<'_, AppState>,
    host_id: String,
    container: Option<String>,
) -> Result<usize, String> {
    let host = load_host(&state, &host_id)?;
    let password = resolve_password(&host)?;
    let session = connection::connect(&host, Some(&password)).await?;
    let target = crate::remote::docker::RemoteTarget::new(
        &session.sftp,
        &session.channel,
        container.as_deref(),
    )?;
    crate::remote::mcp::import_remote_mcp_from_apps(&target, &host.default_home()).await
}

/// 读取远端 `~/.claude/CLAUDE.md` 内容（文件缺失返回空字符串）。
#[tauri::command]
pub async fn read_remote_prompt(
    state: State<'_, AppState>,
    host_id: String,
    container: Option<String>,
) -> Result<String, String> {
    let host = load_host(&state, &host_id)?;
    let password = resolve_password(&host)?;
    let session = connection::connect(&host, Some(&password)).await?;
    let target = crate::remote::docker::RemoteTarget::new(
        &session.sftp,
        &session.channel,
        container.as_deref(),
    )?;
    crate::remote::prompt::read_remote_prompt(&target, &host.default_home()).await
}

/// 将内容整文件原子写回远端 `~/.claude/CLAUDE.md`。
#[tauri::command]
pub async fn write_remote_prompt(
    state: State<'_, AppState>,
    host_id: String,
    content: String,
    container: Option<String>,
) -> Result<bool, String> {
    let host = load_host(&state, &host_id)?;
    let password = resolve_password(&host)?;
    let session = connection::connect(&host, Some(&password)).await?;
    let target = crate::remote::docker::RemoteTarget::new(
        &session.sftp,
        &session.channel,
        container.as_deref(),
    )?;
    crate::remote::prompt::write_remote_prompt(&target, &host.default_home(), &content).await?;
    Ok(true)
}

/// 列出远端 prompts.json 中的提示词列表。
#[tauri::command]
pub async fn list_remote_prompts(
    state: State<'_, AppState>,
    host_id: String,
    container: Option<String>,
) -> Result<Vec<crate::prompt::Prompt>, String> {
    let host = load_host(&state, &host_id)?;
    let password = resolve_password(&host)?;
    let session = connection::connect(&host, Some(&password)).await?;
    let target = crate::remote::docker::RemoteTarget::new(
        &session.sftp, &session.channel, container.as_deref(),
    )?;
    crate::remote::prompt::read_remote_prompts(&target, &host.default_home()).await
}

/// 保存（新增/更新）远端提示词列表，并同步启用项到 CLAUDE.md。
#[tauri::command]
pub async fn save_remote_prompts(
    state: State<'_, AppState>,
    host_id: String,
    prompts: Vec<crate::prompt::Prompt>,
    container: Option<String>,
) -> Result<bool, String> {
    let host = load_host(&state, &host_id)?;
    let password = resolve_password(&host)?;
    let session = connection::connect(&host, Some(&password)).await?;
    let target = crate::remote::docker::RemoteTarget::new(
        &session.sftp, &session.channel, container.as_deref(),
    )?;
    crate::remote::prompt::write_remote_prompts(&target, &host.default_home(), &prompts).await?;
    Ok(true)
}

/// 列出远端 `~/.claude/skills/` 下的已安装技能目录。
#[tauri::command]
pub async fn list_remote_skills(
    state: State<'_, AppState>,
    host_id: String,
    container: Option<String>,
) -> Result<Vec<crate::remote::skill::RemoteSkillEntry>, String> {
    let host = load_host(&state, &host_id)?;
    let password = resolve_password(&host)?;
    let session = connection::connect(&host, Some(&password)).await?;
    let target = crate::remote::docker::RemoteTarget::new(
        &session.sftp,
        &session.channel,
        container.as_deref(),
    )?;
    crate::remote::skill::list_remote_skills(&target, &host.default_home()).await
}

/// 删除远端 SSOT 中的技能（目录 + symlink + skills.json）。
#[tauri::command]
pub async fn delete_remote_skill(
    state: State<'_, AppState>,
    host_id: String,
    name: String,
    container: Option<String>,
) -> Result<bool, String> {
    let host = load_host(&state, &host_id)?;
    let password = resolve_password(&host)?;
    let session = connection::connect(&host, Some(&password)).await?;
    let target = crate::remote::docker::RemoteTarget::new(
        &session.sftp,
        &session.channel,
        container.as_deref(),
    )?;
    crate::remote::skill::delete_remote_skill(
        &target,
        Some(&session.channel),
        container.as_deref(),
        &host.default_home(),
        &name,
    )
    .await
}

/// 切换远端技能在某应用的启用状态（更新 skills.json + 增删 symlink）。
#[tauri::command]
pub async fn toggle_remote_skill_app(
    state: State<'_, AppState>,
    host_id: String,
    name: String,
    app: String,
    enabled: bool,
    container: Option<String>,
) -> Result<bool, String> {
    let host = load_host(&state, &host_id)?;
    let password = resolve_password(&host)?;
    let session = connection::connect(&host, Some(&password)).await?;
    let target = crate::remote::docker::RemoteTarget::new(
        &session.sftp,
        &session.channel,
        container.as_deref(),
    )?;

    let mut records = crate::remote::skill::read_remote_skills_json(&target, &host.default_home()).await?;
    let idx = records
        .iter()
        .position(|r| r.id == name)
        .ok_or_else(|| format!("技能 {name} 不存在"))?;
    // 解析出真正的目录名（前端可能传 id UUID 或 directory）
    let dir = records[idx].directory.clone();

    // 更新 apps 字段
    match app.as_str() {
        "claude" => records[idx].apps.claude = enabled,
        "codex" => records[idx].apps.codex = enabled,
        "gemini" => records[idx].apps.gemini = enabled,
        "grokbuild" => records[idx].apps.grokbuild = enabled,
        "opencode" => records[idx].apps.opencode = enabled,
        "openclaw" => records[idx].apps.openclaw = enabled,
        "hermes" => records[idx].apps.hermes = enabled,
        _ => return Err(format!("未知应用: {app}")),
    }

    // 序列化 JSON + base64 编码，准备通过 stdin 管道发送
    let json_path = crate::remote::skill::remote_skills_json_path(&host.default_home());
    let json_str = serde_json::to_string_pretty(&records)
        .map_err(|e| format!("序列化 skills.json 失败: {e}"))?;
    use base64::Engine as _;
    let b64 = base64::engine::general_purpose::STANDARD.encode(json_str.as_bytes());

    // 构建合并命令：写 JSON + 操作链接（同一次 SSH round-trip）
    let use_copy = crate::settings::get_skill_sync_method() == crate::services::skill::SyncMethod::Copy;
    let link_script = if enabled {
        let app_rel = match app.as_str() {
            "claude" => ".claude/skills",
            "codex" => ".codex/skills",
            "gemini" => ".gemini/skills",
            "grokbuild" => ".grok/skills",
            "opencode" => ".config/opencode/skills",
            "openclaw" => ".openclaw/workspace/skills",
            "hermes" => ".hermes/skills",
            _ => return Err(format!("未知应用: {app}")),
        };
        let link_path = format!("{}/{}/{}", host.default_home(), app_rel, dir);
        let ssot_dir = crate::remote::skill::remote_ssot_path(&host.default_home());
        let target_path = format!("{ssot_dir}/{dir}");
        let app_dir = format!("{}/{}", host.default_home(), app_rel);
        let sync_op = if use_copy {
            format!("cp -r {} {}", shell_q_rs(&target_path), shell_q_rs(&link_path))
        } else {
            format!("ln -s {} {}", shell_q_rs(&target_path), shell_q_rs(&link_path))
        };
        format!("mkdir -p {} && rm -rf {} && {}", shell_q_rs(&app_dir), shell_q_rs(&link_path), sync_op)
    } else {
        let app_rel = match app.as_str() {
            "claude" => ".claude/skills",
            "codex" => ".codex/skills",
            "gemini" => ".gemini/skills",
            "grokbuild" => ".grok/skills",
            "opencode" => ".config/opencode/skills",
            "openclaw" => ".openclaw/workspace/skills",
            "hermes" => ".hermes/skills",
            _ => return Ok(true),
        };
        let link_path = format!("{}/{}/{}", host.default_home(), app_rel, dir);
        format!("rm -rf {}", shell_q_rs(&link_path))
    };

    let combined = format!("base64 -d > {} && {}", shell_q_rs(&json_path), link_script);
    let full_cmd = match container.as_deref() {
        Some(c) => format!("docker exec -i {} sh -c {}", c, shell_q_rs(&combined)),
        None => combined,
    };
    crate::remote::connection::exec_command_with_stdin(&session.channel, &full_cmd, b64.as_bytes()).await?;

    Ok(true)
}

fn shell_q_rs(s: &str) -> String {
    if s.contains('\'') {
        format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
    } else {
        format!("'{s}'")
    }
}

/// 从本地 ZIP 安装技能到远端 SSOT → 写 skills.json → 创建 symlink。
#[tauri::command]
pub async fn install_remote_skills_from_zip(
    state: State<'_, AppState>,
    host_id: String,
    zip_path: String,
    container: Option<String>,
) -> Result<Vec<crate::remote::skill::RemoteSkillRecord>, String> {
    let host = load_host(&state, &host_id)?;
    let password = resolve_password(&host)?;
    let session = connection::connect(&host, Some(&password)).await?;
    let target = crate::remote::docker::RemoteTarget::new(
        &session.sftp,
        &session.channel,
        container.as_deref(),
    )?;

    // 解压 + 上传到 SSOT
    let installed = crate::remote::skill::install_remote_skills_from_zip_generic(
        &session.sftp,
        &session.channel,
        container.as_deref(),
        &host.default_home(),
        &zip_path,
    )
    .await?;

    // 对每个新安装的技能：写 skills.json + 创建 symlink，同时收集完整记录
    let ssot_dir = crate::remote::skill::remote_ssot_path(&host.default_home());
    let mut records = crate::remote::skill::read_remote_skills_json(&target, &host.default_home()).await?;
    let apps = crate::remote::skill::RemoteSkillApps { claude: true, ..Default::default() };
    let use_copy = crate::settings::get_skill_sync_method() == crate::services::skill::SyncMethod::Copy;
    let mut result: Vec<crate::remote::skill::RemoteSkillRecord> = Vec::new();

    for name in &installed {
        let skill_dir = format!("{ssot_dir}/{name}");
        let (display_name, description) = crate::remote::skill::read_skill_md_meta_static(&target, &skill_dir).await;
        let record = crate::remote::skill::build_remote_skill_record(
            name,
            display_name,
            description,
            None,
            None,
            None,
            None,
            apps.clone(),
        );
        records.push(record.clone());
        result.push(record);
        crate::remote::skill::sync_remote_skill_links(
            &session.channel,
            container.as_deref(),
            &host.default_home(),
            name,
            &apps,
            use_copy,
        ).await?;
    }

    crate::remote::skill::write_remote_skills_json(&target, &host.default_home(), &records).await?;
    Ok(result)
}

/// 从「发现技能」列表把一个技能安装到远端。
///
/// 对齐本机 `install_skill_unified` 语义：网络动作（从 GitHub 仓库下载 zip）走本机，
/// 下载后上传到远端 SSOT → 写 skills.json → 建链接。同仓库同名复用，不同仓库同名报错。
#[tauri::command]
pub async fn install_remote_skill_from_discoverable(
    state: State<'_, AppState>,
    host_id: String,
    skill: crate::services::skill::DiscoverableSkill,
    container: Option<String>,
) -> Result<crate::remote::skill::RemoteSkillRecord, String> {
    let host = load_host(&state, &host_id)?;
    let password = resolve_password(&host)?;
    let session = connection::connect(&host, Some(&password)).await?;
    let target = crate::remote::docker::RemoteTarget::new(
        &session.sftp,
        &session.channel,
        container.as_deref(),
    )?;
    let root = host.default_home();
    let channel = &session.channel;
    let container_ref = container.as_deref();

    // 1. 安装目录名 = directory 最后一段（对齐本机 sanitize_install_name）。
    let install_name = crate::remote::skill::sanitize_name(
        skill.directory.rsplit(['/', '\\']).next().unwrap_or(&skill.directory),
    );
    if install_name.is_empty() {
        return Err("无效的技能目录名".to_string());
    }

    // 2. 冲突检测（对齐本机 install 的 DB 检查：同仓库更新启用，不同仓库报错）。
    let mut records =
        crate::remote::skill::read_remote_skills_json(&target, &root).await?;
    let apps =
        crate::remote::skill::RemoteSkillApps { claude: true, ..Default::default() };
    if let Some(existing) = records
        .iter()
        .find(|r| r.directory.eq_ignore_ascii_case(&install_name))
    {
        let same_repo = existing.repo_owner.as_deref() == Some(skill.repo_owner.as_str())
            && existing.repo_name.as_deref() == Some(skill.repo_name.as_str());
        if !same_repo {
            return Err(format!(
                "远端已存在同名技能目录 {install_name}（来自 {}/{}），请先卸载或选择其他仓库",
                existing.repo_owner.as_deref().unwrap_or("unknown"),
                existing.repo_name.as_deref().unwrap_or("unknown")
            ));
        }
        // 复制记录再改，避免可变借用横跨 sync/write 导致借用冲突。
        let mut updated = existing.clone();
        updated.apps = apps.clone();
        updated.updated_at = chrono::Utc::now().timestamp_millis();
        let use_copy = crate::settings::get_skill_sync_method()
            == crate::services::skill::SyncMethod::Copy;
        crate::remote::skill::sync_remote_skill_links(
            channel,
            container_ref,
            &root,
            &install_name,
            &updated.apps,
            use_copy,
        )
        .await?;
        crate::remote::skill::write_remote_skills_json(&target, &root, &records).await?;
        return Ok(updated);
    }

    // 3. 本机下载仓库 + 解析技能源目录（与本地 install 同一实现，含路径安全校验）。
    let service = crate::services::skill::SkillService::new();
    // _temp_guard 保持存活直到上传完成（作用域末尾才释放），防止下载目录被提前回收。
    let (_temp_guard, source_dir, _used_branch) = service
        .download_and_resolve_skill_source(&skill)
        .await
        .map_err(|e| e.to_string())?;

    // 4. 上传远端 SSOT。
    let ssot_dir = crate::remote::skill::remote_ssot_path(&root);
    let remote_dir = format!("{ssot_dir}/{install_name}");
    crate::remote::skill::upload_dir_via_tar(channel, container_ref, &source_dir, &remote_dir)
        .await?;

    // 5. 写 skills.json 记录 + 建链接。
    let description = if skill.description.is_empty() {
        None
    } else {
        Some(skill.description.clone())
    };
    let record = crate::remote::skill::build_remote_skill_record(
        &install_name,
        Some(skill.name.clone()),
        description,
        Some(skill.repo_owner.clone()),
        Some(skill.repo_name.clone()),
        Some(skill.repo_branch.clone()),
        skill.readme_url.clone(),
        apps.clone(),
    );
    records.push(record.clone());
    let use_copy = crate::settings::get_skill_sync_method()
        == crate::services::skill::SyncMethod::Copy;
    crate::remote::skill::sync_remote_skill_links(
        channel,
        container_ref,
        &root,
        &install_name,
        &apps,
        use_copy,
    )
    .await?;
    crate::remote::skill::write_remote_skills_json(&target, &root, &records).await?;

    Ok(record)
}

/// 从本地单个技能目录直接上传到远端 `~/.claude/skills/`（递归）。
/// 宿主机走 SFTP，容器内走 docker exec base64 编码写入。
#[tauri::command]
pub async fn install_remote_skill_from_dir(
    state: State<'_, AppState>,
    host_id: String,
    local_path: String,
    container: Option<String>,
) -> Result<String, String> {
    let host = load_host(&state, &host_id)?;
    let password = resolve_password(&host)?;
    let session = connection::connect(&host, Some(&password)).await?;

    let local_path = std::path::Path::new(&local_path);
    let dir_name = local_path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .ok_or_else(|| "无法确定技能目录名".to_string())?;
    let install_name = crate::remote::skill::sanitize_name(&dir_name);
    if install_name.is_empty() {
        return Err("技能目录名无效".to_string());
    }

    let skills_root = crate::remote::skill::remote_ssot_path(&host.default_home());
    let remote_dir = format!("{skills_root}/{install_name}");

    // 检查是否已存在（宿主机 SFTP）
    let fs = crate::fsops::RemoteSftpFileOps { sftp: &session.sftp };
    let existing =
        crate::remote::skill::list_remote_skills(&fs, &host.default_home()).await?;
    if existing.iter().any(|e| e.name == install_name) {
        return Err(format!("远端已存在技能 {install_name}，请先删除再导入"));
    }

    crate::remote::skill::upload_dir_via_tar(
        &session.channel,
        container.as_deref(),
        local_path,
        &remote_dir,
    )
    .await?;
    Ok(install_name)
}

/// 在远端文件系统上扫描未管理的技能目录（远端「导入已有」的扫描阶段）。
///
/// 容器模式：用合并 shell 脚本一次 exec 收集所有源目录的技能，避免逐文件 exec 调用过多导致延迟。
#[tauri::command]
pub async fn scan_remote_unmanaged_skills(
    state: State<'_, AppState>,
    host_id: String,
    container: Option<String>,
) -> Result<Vec<crate::remote::skill::RemoteUnmanagedSkill>, String> {
    let host = load_host(&state, &host_id)?;
    let password = resolve_password(&host)?;
    let session = connection::connect(&host, Some(&password)).await?;
    let root = host.default_home();

    if let Some(ref c) = container {
        return scan_container_unmanaged_skills(&session.channel, c, &root).await;
    }

    let target = crate::remote::docker::RemoteTarget::new(
        &session.sftp, &session.channel, None,
    )?;
    crate::remote::skill::scan_remote_unmanaged_skills(&target, &root).await
}

/// 容器内批量扫描：一个 shell 脚本一趟 exec 收完所有源目录。
async fn scan_container_unmanaged_skills(
    channel: &russh::client::Handle<crate::remote::connection::RemoteHandler>,
    container: &str,
    root: &str,
) -> Result<Vec<crate::remote::skill::RemoteUnmanagedSkill>, String> {
    // 已管理技能：读 skills.json
    let json_path = crate::remote::skill::remote_skills_json_path(root);
    let managed_json = crate::remote::connection::exec_command(
        channel,
        &format!("docker exec {} sh -c {}", container, shell_q_rs(&format!("cat {} 2>/dev/null", shell_q_rs(&json_path)))),
    ).await.unwrap_or_default();
    let managed: std::collections::HashSet<String> = if managed_json.trim().is_empty() {
        Default::default()
    } else {
        serde_json::from_str::<Vec<crate::remote::skill::RemoteSkillRecord>>(&managed_json)
            .unwrap_or_default()
            .into_iter()
            .map(|r| r.directory)
            .collect()
    };

    // 源目录列表
    let sources: [(&str, &str); 8] = [
        ("cc-switch", ".cc-switch/skills"),
        ("claude", ".claude/skills"),
        ("codex", ".codex/skills"),
        ("gemini", ".gemini/skills"),
        ("grokbuild", ".grok/skills"),
        ("opencode", ".config/opencode/skills"),
        ("openclaw", ".openclaw/workspace/skills"),
        ("hermes", ".hermes/skills"),
    ];

    let mut unmanaged: std::collections::HashMap<String, crate::remote::skill::RemoteUnmanagedSkill> =
        Default::default();

    for (label, app_rel) in &sources {
        let src = format!("{root}/{app_rel}");
        let script = format!(
            "for d in {src}/*/; do name=$(basename \"$d\"); case \"$name\" in .*) continue ;; esac; if [ -f \"$d/SKILL.md\" ]; then echo CCSW_NAME:$name; echo CCSW_PATH:$d; cat \"$d/SKILL.md\"; echo CCSW_END; fi; done",
        );
        let out = crate::remote::connection::exec_command(
            channel,
            &format!("docker exec {} sh -c {}", container, shell_q_rs(&script)),
        ).await.unwrap_or_default();

        // 解析输出
        for block in out.split("CCSW_END") {
            let block = block.trim();
            if block.is_empty() { continue; }
            let dir = block.lines()
                .find(|l| l.starts_with("CCSW_NAME:"))
                .map(|l| l.trim_start_matches("CCSW_NAME:").to_string());
            let dir = match dir {
                Some(d) => d,
                None => continue,
            };
            if managed.contains(&dir) { continue; }
            let dir_path = block.lines()
                .find(|l| l.starts_with("CCSW_PATH:"))
                .map(|l| l.trim_start_matches("CCSW_PATH:").trim().to_string())
                .unwrap_or_default();

            // 解析 SKILL.md 内容中的 YAML frontmatter
            let filtered: Vec<&str> = block.lines()
                .filter(|l| !l.starts_with("CCSW_NAME:") && !l.starts_with("CCSW_PATH:"))
                .collect();
            let content = filtered.join("\n");
            let parts: Vec<&str> = content.trim().splitn(3, "---").collect();
            let (display_name, description) = if parts.len() >= 3 {
                match serde_yaml::from_str::<serde_json::Value>(parts[1].trim()) {
                    Ok(meta) => (
                        meta.get("name").and_then(|v| v.as_str()).map(|s| s.to_string()),
                        meta.get("description").and_then(|v| v.as_str()).map(|s| s.to_string()),
                    ),
                    Err(_) => (None, None),
                }
            } else { (None, None) };
            let name = display_name.unwrap_or_else(|| dir.clone());
            let label_str = label.to_string();
            unmanaged.entry(dir.clone())
                .and_modify(|s| s.found_in.push(label_str.clone()))
                .or_insert(crate::remote::skill::RemoteUnmanagedSkill {
                    directory: dir,
                    name,
                    description,
                    found_in: vec![label_str.clone()],
                    path: dir_path,
                });
        }
    }

    let mut out: Vec<crate::remote::skill::RemoteUnmanagedSkill> = unmanaged.into_values().collect();
    out.sort_by(|a, b| a.directory.cmp(&b.directory));
    Ok(out)
}

/// 在远端将技能目录复制到 SSOT → 更新 skills.json → 创建链接（symlink 或 copy，取决于本机设置）。
#[tauri::command]
pub async fn import_remote_skill(
    state: State<'_, AppState>,
    host_id: String,
    source_path: String,
    name: String,
    container: Option<String>,
) -> Result<crate::remote::skill::RemoteSkillRecord, String> {
    let host = load_host(&state, &host_id)?;
    let password = resolve_password(&host)?;
    let session = connection::connect(&host, Some(&password)).await?;
    let target = crate::remote::docker::RemoteTarget::new(
        &session.sftp,
        &session.channel,
        container.as_deref(),
    )?;
    let apps = crate::remote::skill::RemoteSkillApps {
        claude: true,
        ..Default::default()
    };
    let use_copy = crate::settings::get_skill_sync_method() == crate::services::skill::SyncMethod::Copy;
    crate::remote::skill::import_remote_skill_local(
        &target,
        &session.channel,
        container.as_deref(),
        &host.default_home(),
        &source_path,
        &name,
        &apps,
        use_copy,
    )
    .await
}

/// 清理远端 shell 配置中的冲突环境变量（注释 + .bak 备份）。
#[tauri::command]
pub async fn clean_remote_env_conflicts(
    state: State<'_, AppState>,
    host_id: String,
    container: Option<String>,
) -> Result<serde_json::Value, String> {
    let host = load_host(&state, &host_id)?;
    let password = resolve_password(&host)?;
    let session = connection::connect(&host, Some(&password)).await?;
    let target = crate::remote::docker::RemoteTarget::new(
        &session.sftp,
        &session.channel,
        container.as_deref(),
    )?;
    let home = host.default_home();
    let conflicts = crate::remote::env_clean::scan_remote_env_conflicts(&target, &home).await?;
    let cleaned = crate::remote::env_clean::clean_remote_env_conflicts(&target, &conflicts).await?;
    Ok(json!({ "cleaned": cleaned, "total": conflicts.len() }))
}

/// 列出远端主机上的 Docker 容器（`docker ps` 解析），供「目标 = 容器」选择。
#[tauri::command]
pub async fn list_docker_containers(
    state: State<'_, AppState>,
    host_id: String,
) -> Result<Vec<String>, String> {
    let host = load_host(&state, &host_id)?;
    let password = resolve_password(&host)?;
    let session = connection::connect(&host, Some(&password)).await?;
    crate::remote::docker::list_docker_containers(&session.channel).await
}

/// 检测 claude 是否安装的**标记**（命令命中时输出；调用方按 `contains` 判断）。
const CLAUDE_INSTALLED_MARKER: &str = "CC_SWITCH_FOUND";

/// 生成「检测 claude 是否安装」的 shell 命令。
///
/// 不用「输出非空」判断（stderr 混流/时序抖动都会误判），改用固定哨兵：
/// 命中则输出 `CC_SWITCH_FOUND`，未命中 stderr 丢弃、无哨兵。
/// `|| true` 保证命令本身成功退出，避免非零退出码带来的读取歧义。
/// `container` 为 Some 时包一层 `docker exec <c> sh -c '...'`。
fn claude_installed_probe(container: Option<&str>) -> String {
    let inner = format!(
        "command -v claude 2>/dev/null && echo {} || true",
        CLAUDE_INSTALLED_MARKER
    );
    match container {
        Some(c) => format!("docker exec {c} sh -c '{inner}'"),
        None => inner,
    }
}

/// 按 id 加载主机，不存在时报错。
fn load_host(state: &AppState, host_id: &str) -> Result<RemoteHost, String> {
    state
        .db
        .get_remote_host(host_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "远程主机不存在，可能已被删除".to_string())
}

/// 解析连接用密码：优先系统钥匙串；否则要求编辑主机补充密码。
fn resolve_password(host: &RemoteHost) -> Result<String, String> {
    log::info!("[remote] resolve_password: id={}", host.id);
    let pw = credentials::get_password(&host.id).map_err(|e| {
        log::error!("[remote] 钥匙串读取失败: {e}");
        e
    })?;
    match pw {
        Some(p) => {
            log::info!("[remote] 钥匙串命中 id={}", host.id);
            Ok(p)
        }
        None => {
            log::error!("[remote] 钥匙串未命中 id={}", host.id);
            Err("未找到该主机的密码，请在编辑界面重新填写".to_string())
        }
    }
}
