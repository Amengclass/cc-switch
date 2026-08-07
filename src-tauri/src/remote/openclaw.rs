//! 远端 OpenClaw 供应商切换（复用本机 `write_live_snapshot` 的 OpenClaw 分支语义，
//! 远端只做 I/O）。
//!
//! 与本机一致：additive 模式 —— settings_config 能解析为 `OpenClawProviderConfig`
//! 或含 `baseUrl`/`api`/`models` 才写；对远端 `~/.openclaw/openclaw.json` 的
//! `models.providers` 段 upsert `providers[id]`（保留 `models.mode` 与其他顶层段）。

use serde_json::{json, Value};

use super::connection::RemoteSession;
use super::effect::EffectReport;

/// 对远端执行 OpenClaw 供应商切换。
///
/// - `settings`：DB 中该 provider 的 `settings_config`
/// - `provider_id`：写入 `models.providers.{provider_id}`
pub async fn apply_openclaw_provider_settings(
    session: &RemoteSession,
    container: Option<&str>,
    root: &str,
    target_name: &str,
    provider_name: &str,
    settings: &Value,
    provider_id: &str,
) -> Result<EffectReport, String> {
    let config_path = format!("{root}/.openclaw/openclaw.json");

    // 校验（与本机 live.rs OpenClaw 分支一致）
    let parsed =
        serde_json::from_value::<crate::openclaw_config::OpenClawProviderConfig>(settings.clone());
    let is_valid = parsed.is_ok()
        || settings.get("baseUrl").is_some()
        || settings.get("api").is_some()
        || settings.get("models").is_some();
    if !is_valid {
        return Err(format!(
            "OpenClaw provider '{provider_id}' has invalid config structure for live config (must contain 'baseUrl', 'api', or 'models')"
        ));
    }

    // 读远端 openclaw.json（JSON5 兼容解析；不存在视为空）
    let existing: Value = session
        .read_remote_text(&config_path, container)
        .await?
        .map(|t| json5::from_str(&t).unwrap_or_else(|_| json!({})))
        .unwrap_or_else(|| json!({}));
    let mut merged = existing;

    // models 段：缺失时按本机 set_provider 默认 {"mode":"merge","providers":{}}
    let mut models = merged
        .get("models")
        .cloned()
        .unwrap_or_else(|| json!({ "mode": "merge", "providers": {} }));
    let mut providers = models
        .get("providers")
        .cloned()
        .unwrap_or_else(|| json!({}));
    if let Some(p) = providers.as_object_mut() {
        p.insert(provider_id.to_string(), settings.clone());
    }
    models["providers"] = providers;
    merged["models"] = models;

    let text = serde_json::to_string_pretty(&merged)
        .map_err(|e| format!("序列化 openclaw.json 失败: {e}"))?;
    session
        .write_settings_with_backup(&config_path, &text, container, None)
        .await?;

    Ok(EffectReport {
        target: target_name.to_string(),
        provider_name: provider_name.to_string(),
        current_provider_id: None,
        conflicts_cleaned: 0,
        notes: vec![
            format!("已更新远端 {config_path} 的 models.providers.{provider_id}"),
            "新建的 OpenClaw 会话立即生效".to_string(),
        ],
    })
}
