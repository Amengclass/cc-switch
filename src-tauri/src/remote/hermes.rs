//! 远端 Hermes 供应商切换（复用本机 `hermes_config::set_provider` 语义，
//! 远端只做 I/O）。
//!
//! 与本机一致：`custom_providers` 序列按 name upsert ——
//! ① `sanitize_hermes_provider_keys`（camelCase → snake）
//! ② `normalize_provider_models_for_write`（models 数组 → dict）
//! ③ 注入 `name` 字段 + 第一个 model id 作为 `model` 字段
//! ④ 命中已有条目时合并远端额外字段（forward-compat），否则 push。
//! 远端文件为 YAML（`~/.hermes/config.yaml`），整体读-改-写。

use serde_json::Value;

use super::connection::RemoteSession;
use super::effect::EffectReport;

/// 对远端执行 Hermes 供应商切换。
///
/// - `settings`：DB 中该 provider 的 `settings_config`
/// - `provider_id`：作为 `custom_providers[].name`
pub async fn apply_hermes_provider_settings(
    session: &RemoteSession,
    container: Option<&str>,
    root: &str,
    target_name: &str,
    provider_name: &str,
    settings: &Value,
    provider_id: &str,
) -> Result<EffectReport, String> {
    let config_path = format!("{root}/.hermes/config.yaml");

    // 读远端 config.yaml（不存在 / 解析失败视为空配置）
    let mut root_yaml: serde_yaml::Value = match session
        .read_remote_text(&config_path, container)
        .await?
    {
        Some(t) => serde_yaml::from_str(&t).unwrap_or_else(|_| serde_yaml::Value::Null),
        None => serde_yaml::Value::Null,
    };
    if !root_yaml.is_mapping() {
        root_yaml = serde_yaml::Value::Mapping(Default::default());
    }

    // 复刻本机 set_provider 的变换链
    let mut normalized = settings.clone();
    crate::hermes_config::sanitize_hermes_provider_keys(&mut normalized);
    crate::hermes_config::normalize_provider_models_for_write(&mut normalized);

    let first_model_id = normalized
        .get("models")
        .and_then(|v| v.as_object())
        .and_then(|obj| obj.keys().next())
        .cloned();

    let mut yaml_val = crate::hermes_config::json_to_yaml(&normalized)
        .map_err(|e| format!("序列化 Hermes provider 失败: {e}"))?;
    if let serde_yaml::Value::Mapping(ref mut m) = yaml_val {
        m.insert(
            serde_yaml::Value::String("name".to_string()),
            serde_yaml::Value::String(provider_id.to_string()),
        );
        if let Some(model_id) = first_model_id {
            m.insert(
                serde_yaml::Value::String("model".to_string()),
                serde_yaml::Value::String(model_id),
            );
        } else {
            m.remove(serde_yaml::Value::String("model".to_string()));
        }
    }

    // custom_providers 序列 upsert（含 forward-compat merge，照本机 838-857）
    let mut providers: Vec<serde_yaml::Value> = root_yaml
        .get("custom_providers")
        .and_then(|v| v.as_sequence())
        .cloned()
        .unwrap_or_default();
    if let Some(existing) = providers
        .iter_mut()
        .find(|p| p.get("name").and_then(|n| n.as_str()) == Some(provider_id))
    {
        if let (Some(existing_map), serde_yaml::Value::Mapping(new_map)) =
            (existing.as_mapping(), &mut yaml_val)
        {
            for (k, v) in existing_map {
                new_map.entry(k.clone()).or_insert_with(|| v.clone());
            }
        }
        *existing = yaml_val;
    } else {
        providers.push(yaml_val);
    }

    if let Some(root_map) = root_yaml.as_mapping_mut() {
        root_map.insert(
            serde_yaml::Value::String("custom_providers".to_string()),
            serde_yaml::Value::Sequence(providers),
        );
    }

    let text = serde_yaml::to_string(&root_yaml)
        .map_err(|e| format!("序列化 config.yaml 失败: {e}"))?;
    session
        .write_settings_with_backup(&config_path, &text, container, None)
        .await?;

    Ok(EffectReport {
        target: target_name.to_string(),
        provider_name: provider_name.to_string(),
        current_provider_id: None,
        conflicts_cleaned: 0,
        notes: vec![
            format!("已更新远端 {config_path} 的 custom_providers.{provider_id}"),
            "新建的 Hermes 会话立即生效".to_string(),
        ],
    })
}
