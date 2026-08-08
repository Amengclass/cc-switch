//! 远端供应商 SSOT：`~/.cc-switch/providers/{app}.json`
//!
//! 每个目标机器（宿主机 / 容器）维护自己的一份完整供应商候选池，与本机
//! SQLite providers 表同构（`Provider` 记录 + `current_provider_id`）。
//! live 文件（settings.json / opencode.json / ...）保持不变。
//!
//! 与本机语义对齐：
//! - additive（opencode/openclaw/hermes）：live 即完整集合，每次读 SSOT 时
//!   幂等同步 live → SSOT（对齐本机启动自动导入 lib.rs）；
//! - 非 additive（claude/codex/gemini/grokbuild）：仅当 SSOT 为空才从 live
//!   导入一条 `default`（对齐 `should_import_default_config_on_startup`）。
//!
//! 通过 `FileOps` 支持宿主机（SFTP）与容器（docker exec）。

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::fsops::FileOps;
use crate::provider::{Provider, ProviderMeta};

/// 是否 additive 模式 app（live 即完整供应商集合）。
pub fn is_additive_app(app: &str) -> bool {
    matches!(app, "opencode" | "openclaw" | "hermes")
}

/// SSOT 文件路径。
pub fn remote_providers_ssot_path(root: &str, app: &str) -> String {
    format!("{root}/.cc-switch/providers/{app}.json")
}

/// SSOT 文件内容（版本化，未来可扩展）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteProvidersSsot {
    #[serde(default)]
    pub version: u32,
    /// 非 additive 的当前生效供应商（对齐 DB `is_current`）；additive 不维护
    /// （由 live 决定 current）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_provider_id: Option<String>,
    #[serde(default)]
    pub providers: Vec<Provider>,
}

impl Default for RemoteProvidersSsot {
    fn default() -> Self {
        Self {
            version: 1,
            current_provider_id: None,
            providers: Vec::new(),
        }
    }
}

/// 读远端 SSOT；文件缺失视为空。
pub async fn read_remote_providers_ssot<F: FileOps>(
    fs: &F,
    root: &str,
    app: &str,
) -> Result<RemoteProvidersSsot, String> {
    let path = remote_providers_ssot_path(root, app);
    match fs.read_text_optional(&path).await? {
        Some(text) if !text.trim().is_empty() => {
            serde_json::from_str(&text).map_err(|e| format!("解析 {path} 失败: {e}"))
        }
        _ => Ok(RemoteProvidersSsot::default()),
    }
}

/// 原子写回远端 SSOT（键排序保证确定性输出）。
pub async fn write_remote_providers_ssot<F: FileOps>(
    fs: &F,
    root: &str,
    app: &str,
    ssot: &RemoteProvidersSsot,
) -> Result<(), String> {
    let value = serde_json::to_value(ssot)
        .map_err(|e| format!("序列化 providers SSOT 失败: {e}"))?;
    let sorted = crate::config::sort_json_keys(&value);
    let json = serde_json::to_string_pretty(&sorted)
        .map_err(|e| format!("序列化 providers SSOT 失败: {e}"))?;
    fs.write_text_atomic(&remote_providers_ssot_path(root, app), &json)
        .await
}

/// upsert：按 id 更新或追加，返回是否新增。
pub fn upsert_provider(providers: &mut Vec<Provider>, provider: Provider) -> bool {
    match providers.iter_mut().find(|p| p.id == provider.id) {
        Some(existing) => {
            *existing = provider;
            false
        }
        None => {
            providers.push(provider);
            true
        }
    }
}

/// 从远端 live 同步到 SSOT（对齐本机启动导入语义，幂等）。
///
/// 返回 `(变更条数, additive live 供应商 ID 集合)`。
///
/// `auto_import_default`：仅非 additive 生效——true = 每次确保 SSOT 存在一条
/// `default`（内容 = live 当前配置，幂等更新，用户可随时看到当前机器配置）；
/// false = 仅空库才从 live 导入 default（旧行为，更快，方案 A 保留）。
/// live_ids 仅在 additive 时返回本次读到的 live 内容（get 场景直接复用，
/// 省一次对 live 文件的重复读取）；非 additive 恒为空 Vec。
pub async fn sync_remote_live_into_ssot<F: FileOps>(
    fs: &F,
    root: &str,
    app: &str,
    auto_import_default: bool,
) -> Result<(usize, Vec<String>), String> {
    if is_additive_app(app) {
        // additive：live 即完整集合，幂等 upsert（live_config_managed = true）
        let mut ssot = read_remote_providers_ssot(fs, root, app).await?;
        let live = parse_remote_live_providers(fs, root, app).await?;
        let mut changed = 0usize;
        for p in &live {
            if upsert_provider(&mut ssot.providers, p.clone()) {
                changed += 1;
            }
        }
        if changed > 0 {
            write_remote_providers_ssot(fs, root, app, &ssot).await?;
        }
        let live_ids = live.iter().map(|p| p.id.clone()).collect();
        Ok((changed, live_ids))
    } else {
        // 非 additive：live 有内容时——
        // - auto_import_default=true：确保 SSOT 中存在一条 `default`
        //   （内容 = live 当前生效配置，幂等更新）——用户要求：远端要能随时看到
        //   「当前机器实际在用什么配置」。已有候选池时不动 current 标记。
        // - auto_import_default=false：仅空库才从 live 导入 default（旧行为）。
        let Some(default) = parse_remote_live_default(fs, root, app).await? else {
            return Ok((0, Vec::new())); // live 无内容 → 不导入
        };
        let mut ssot = read_remote_providers_ssot(fs, root, app).await?;
        if !auto_import_default && !ssot.providers.is_empty() {
            return Ok((0, Vec::new()));
        }
        let already_fresh = ssot.providers.iter().any(|p| {
            p.id == "default" && p.settings_config == default.settings_config
        });
        if already_fresh {
            return Ok((0, Vec::new()));
        }
        // 空库首导时把 default 设为 current；已有候选池时保留用户切换的记录
        if ssot.providers.is_empty() {
            ssot.current_provider_id = Some("default".to_string());
        }
        upsert_provider(&mut ssot.providers, default);
        write_remote_providers_ssot(fs, root, app, &ssot).await?;
        Ok((1, Vec::new()))
    }
}

/// additive：解析远端 live 文件为 Provider 列表
/// （对齐本机 `import_*_providers_from_live` 的字段语义）。
async fn parse_remote_live_providers<F: FileOps>(
    fs: &F,
    root: &str,
    app: &str,
) -> Result<Vec<Provider>, String> {
    let mut out = Vec::new();
    match app {
        "opencode" => {
            let path = format!("{root}/.config/opencode/opencode.json");
            let Some(text) = fs.read_text_optional(&path).await? else {
                return Ok(out);
            };
            let value = serde_json::from_str::<Value>(&text).unwrap_or_else(|_| json!({}));
            let Some(providers_obj) = value
                .get("provider")
                .and_then(Value::as_object)
            else {
                return Ok(out);
            };
            for (id, config_value) in providers_obj {
                match serde_json::from_value::<crate::provider::OpenCodeProviderConfig>(
                    config_value.clone(),
                ) {
                    Ok(config) => {
                        let settings_config = serde_json::to_value(&config)
                            .unwrap_or_else(|_| config_value.clone());
                        let display_name =
                            config.name.clone().unwrap_or_else(|| id.clone());
                        let mut p = Provider::with_id(
                            id.clone(),
                            display_name,
                            settings_config,
                            None,
                        );
                        p.meta = Some(ProviderMeta {
                            live_config_managed: Some(true),
                            ..Default::default()
                        });
                        out.push(p);
                    }
                    Err(e) => log::warn!("解析远端 opencode 供应商 '{id}' 失败: {e}"),
                }
            }
        }
        "openclaw" => {
            let path = format!("{root}/.openclaw/openclaw.json");
            let Some(text) = fs.read_text_optional(&path).await? else {
                return Ok(out);
            };
            let value = json5::from_str::<Value>(&text).unwrap_or_else(|_| json!({}));
            let Some(providers_obj) = value
                .get("models")
                .and_then(|m| m.get("providers"))
                .and_then(Value::as_object)
            else {
                return Ok(out);
            };
            for (id, config_value) in providers_obj {
                if id.trim().is_empty() {
                    continue;
                }
                match serde_json::from_value::<crate::openclaw_config::OpenClawProviderConfig>(
                    config_value.clone(),
                ) {
                    Ok(config) => {
                        if config.models.is_empty() {
                            continue;
                        }
                        let settings_config = serde_json::to_value(&config)
                            .unwrap_or_else(|_| config_value.clone());
                        let display_name = config
                            .models
                            .first()
                            .and_then(|m| m.name.clone())
                            .unwrap_or_else(|| id.clone());
                        let mut p = Provider::with_id(
                            id.clone(),
                            display_name,
                            settings_config,
                            None,
                        );
                        p.meta = Some(ProviderMeta {
                            live_config_managed: Some(true),
                            ..Default::default()
                        });
                        out.push(p);
                    }
                    Err(e) => log::warn!("解析远端 openclaw 供应商 '{id}' 失败: {e}"),
                }
            }
        }
        "hermes" => {
            let path = format!("{root}/.hermes/config.yaml");
            let Some(text) = fs.read_text_optional(&path).await? else {
                return Ok(out);
            };
            let yaml = serde_yaml::from_str::<serde_yaml::Value>(&text)
                .unwrap_or_else(|_| serde_yaml::Value::Null);
            let Ok(value) = crate::hermes_config::yaml_to_json(&yaml) else {
                return Ok(out);
            };
            if let Some(seq) = value.get("custom_providers").and_then(Value::as_array) {
                for item in seq {
                    let Some(name) = item.get("name").and_then(Value::as_str) else {
                        continue;
                    };
                    if name.trim().is_empty() {
                        continue;
                    }
                    let mut p = Provider::with_id(
                        name.to_string(),
                        name.to_string(),
                        item.clone(),
                        None,
                    );
                    p.meta = Some(ProviderMeta {
                        live_config_managed: Some(true),
                        ..Default::default()
                    });
                    out.push(p);
                }
            }
        }
        _ => {}
    }
    Ok(out)
}

/// 非 additive：解析远端 live 为一条 `default` 记录
/// （对齐本机 `import_default_config` 的 settings_config 结构）。
async fn parse_remote_live_default<F: FileOps>(
    fs: &F,
    root: &str,
    app: &str,
) -> Result<Option<Provider>, String> {
    let settings_config = match app {
        "claude" => {
            let path = format!("{root}/.claude/settings.json");
            let Some(text) = fs.read_text_optional(&path).await? else {
                return Ok(None);
            };
            serde_json::from_str::<Value>(&text)
                .map_err(|e| format!("解析远端 settings.json 失败: {e}"))?
        }
        "codex" => {
            let cfg_path = format!("{root}/.codex/config.toml");
            let Some(cfg_text) = fs.read_text_optional(&cfg_path).await? else {
                return Ok(None);
            };
            let auth_path = format!("{root}/.codex/auth.json");
            let auth: Value = match fs.read_text_optional(&auth_path).await? {
                Some(t) => serde_json::from_str(&t).unwrap_or_else(|_| json!({})),
                None => json!({}),
            };
            json!({ "auth": auth, "config": cfg_text })
        }
        "gemini" => {
            let env_path = format!("{root}/.gemini/.env");
            let Some(env_text) = fs.read_text_optional(&env_path).await? else {
                return Ok(None);
            };
            let env_map = crate::gemini_config::parse_env_file(&env_text);
            let env_json = crate::gemini_config::env_to_json(&env_map)
                .get("env")
                .cloned()
                .unwrap_or_else(|| json!({}));
            let settings_path = format!("{root}/.gemini/settings.json");
            let config_obj: Value = match fs.read_text_optional(&settings_path).await? {
                Some(t) => serde_json::from_str(&t).unwrap_or_else(|_| json!({})),
                None => json!({}),
            };
            json!({ "env": env_json, "config": config_obj })
        }
        "grokbuild" => {
            let path = format!("{root}/.grok/config.toml");
            let Some(config) = fs.read_text_optional(&path).await? else {
                return Ok(None);
            };
            json!({ "config": config })
        }
        _ => return Ok(None),
    };

    let mut provider = Provider::with_id(
        "default".to_string(),
        "default".to_string(),
        settings_config,
        None,
    );
    // 对齐本机 import_default_config 的 category 判定（codex 官方登录态 → official）
    if app == "codex" {
        let config_text = provider
            .settings_config
            .get("config")
            .and_then(Value::as_str);
        let has_provider_key = crate::codex_config::extract_codex_api_key(
            provider.settings_config.get("auth"),
            config_text,
        )
        .is_some();
        let has_login_material = provider
            .settings_config
            .get("auth")
            .is_some_and(crate::codex_config::codex_auth_has_login_material);
        provider.category = Some(
            if has_login_material && !has_provider_key {
                "official"
            } else {
                "custom"
            }
            .to_string(),
        );
    } else {
        provider.category = Some("custom".to_string());
    }
    Ok(Some(provider))
}

/// 把 provider 定义应用到远端对应 app 的 live 文件（复用各 remote::*::apply_*
/// 纯变换，产出与本机切换逐字节一致）。claude 分支与本机一致走
/// `build_effective_settings_with_common_config`（通用配置片段来自本机 DB）。
pub async fn apply_remote_provider_to_live(
    db: &crate::database::Database,
    session: &crate::remote::connection::RemoteSession,
    container: Option<&str>,
    home: &str,
    host_name: &str,
    app: &str,
    provider: &Provider,
) -> Result<crate::remote::effect::EffectReport, String> {
    match app {
        "claude" => {
            let effective =
                crate::services::provider::live::build_effective_settings_with_common_config(
                    db,
                    &crate::app_config::AppType::Claude,
                    provider,
                )
                .map_err(|e| e.to_string())?;
            let sanitized =
                crate::services::provider::live::sanitize_claude_settings_for_live(&effective);
            crate::remote::settings::apply_provider_settings(
                session,
                container,
                home,
                host_name,
                &provider.name,
                &sanitized,
            )
            .await
        }
        "codex" => {
            crate::remote::codex::apply_codex_provider_settings(
                session,
                container,
                home,
                host_name,
                &provider.name,
                &provider.settings_config,
                provider.category.as_deref(),
                crate::proxy::providers::resolve_codex_catalog_tool_profile(provider),
            )
            .await
        }
        "grokbuild" => {
            crate::remote::grok::apply_grok_provider_settings(
                session,
                container,
                home,
                host_name,
                &provider.name,
                &provider.settings_config,
                provider.category.as_deref(),
            )
            .await
        }
        "gemini" => {
            crate::remote::gemini::apply_gemini_provider_settings(
                session,
                container,
                home,
                host_name,
                &provider.name,
                &provider.settings_config,
                provider,
            )
            .await
        }
        "opencode" => {
            crate::remote::opencode::apply_opencode_provider_settings(
                session,
                container,
                home,
                host_name,
                &provider.name,
                &provider.settings_config,
                &provider.id,
            )
            .await
        }
        "openclaw" => {
            crate::remote::openclaw::apply_openclaw_provider_settings(
                session,
                container,
                home,
                host_name,
                &provider.name,
                &provider.settings_config,
                &provider.id,
            )
            .await
        }
        "hermes" => {
            crate::remote::hermes::apply_hermes_provider_settings(
                session,
                container,
                home,
                host_name,
                &provider.name,
                &provider.settings_config,
                &provider.id,
            )
            .await
        }
        other => Err(format!("远程切换暂不支持应用: {other}")),
    }
}

/// 读远端 additive live 文件中的供应商 ID 集合（isInConfig 按钮态用）。
pub async fn read_remote_live_provider_ids<F: FileOps>(
    fs: &F,
    root: &str,
    app: &str,
) -> Result<Vec<String>, String> {
    let ids = match app {
        "opencode" => {
            let path = format!("{root}/.config/opencode/opencode.json");
            match fs.read_text_optional(&path).await? {
                Some(text) => serde_json::from_str::<Value>(&text)
                    .unwrap_or_else(|_| json!({}))
                    .get("provider")
                    .and_then(Value::as_object)
                    .map(|p| p.keys().cloned().collect())
                    .unwrap_or_default(),
                None => Vec::new(),
            }
        }
        "openclaw" => {
            let path = format!("{root}/.openclaw/openclaw.json");
            match fs.read_text_optional(&path).await? {
                Some(text) => json5::from_str::<Value>(&text)
                    .unwrap_or_else(|_| json!({}))
                    .get("models")
                    .and_then(|m| m.get("providers"))
                    .and_then(Value::as_object)
                    .map(|p| p.keys().cloned().collect())
                    .unwrap_or_default(),
                None => Vec::new(),
            }
        }
        "hermes" => {
            let path = format!("{root}/.hermes/config.yaml");
            match fs.read_text_optional(&path).await? {
                Some(text) => serde_yaml::from_str::<serde_yaml::Value>(&text)
                    .unwrap_or_else(|_| serde_yaml::Value::Null)
                    .get("custom_providers")
                    .and_then(|v| v.as_sequence())
                    .map(|seq| {
                        seq.iter()
                            .filter_map(|p| p.get("name").and_then(|n| n.as_str()))
                            .map(|n| n.to_string())
                            .collect()
                    })
                    .unwrap_or_default(),
                None => Vec::new(),
            }
        }
        _ => Vec::new(),
    };
    Ok(ids)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fsops::LocalFileOps;

    fn temp_root(tag: &str) -> String {
        let dir = std::env::temp_dir().join(format!(
            "cc-switch-remote-ssot-test-{tag}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir.to_string_lossy().to_string()
    }

    fn sample_provider(id: &str, name: &str) -> Provider {
        let mut p = Provider::with_id(
            id.to_string(),
            name.to_string(),
            json!({ "env": { "ANTHROPIC_BASE_URL": "https://x.example" } }),
            None,
        );
        p.meta = Some(ProviderMeta {
            live_config_managed: Some(true),
            ..Default::default()
        });
        p
    }

    #[test]
    fn upsert_adds_and_updates() {
        let mut list = vec![sample_provider("a", "A")];
        assert!(!upsert_provider(&mut list, sample_provider("a", "A2")));
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "A2");
        assert!(upsert_provider(&mut list, sample_provider("b", "B")));
        assert_eq!(list.len(), 2);
    }

    #[tokio::test]
    async fn ssot_roundtrip_missing_file_is_empty() {
        let root = temp_root("roundtrip");
        let fs = LocalFileOps;
        let empty = read_remote_providers_ssot(&fs, &root, "claude")
            .await
            .expect("read empty");
        assert!(empty.providers.is_empty());

        let mut ssot = RemoteProvidersSsot::default();
        ssot.current_provider_id = Some("a".to_string());
        ssot.providers.push(sample_provider("a", "A"));
        write_remote_providers_ssot(&fs, &root, "claude", &ssot)
            .await
            .expect("write");

        let read = read_remote_providers_ssot(&fs, &root, "claude")
            .await
            .expect("read back");
        assert_eq!(read.current_provider_id.as_deref(), Some("a"));
        assert_eq!(read.providers.len(), 1);
        assert_eq!(read.providers[0].name, "A");
        // 幂等：再写一次仍可读（确定性输出）
        write_remote_providers_ssot(&fs, &root, "claude", &read)
            .await
            .expect("rewrite");
    }

    #[tokio::test]
    async fn sync_additive_imports_live_into_ssot() {
        let root = temp_root("additive");
        let fs = LocalFileOps;
        // 构造远端 live：opencode.json 带两个 provider
        let live = json!({
            "provider": {
                "p1": { "npm": "@ai-sdk/openai-compatible", "name": "P One", "options": { "baseURL": "https://p1.example" } },
                "p2": { "npm": "@ai-sdk/anthropic", "options": { "apiKey": "k" } }
            }
        });
        let path = format!("{root}/.config/opencode/opencode.json");
        std::fs::create_dir_all(std::path::Path::new(&path).parent().unwrap()).unwrap();
        std::fs::write(&path, serde_json::to_string_pretty(&live).unwrap()).unwrap();

        let (changed, live_ids) = sync_remote_live_into_ssot(&fs, &root, "opencode", false)
            .await
            .expect("sync");
        assert_eq!(changed, 2);
        assert_eq!(live_ids.len(), 2); // additive：顺带返回 live ID 集合
        assert!(live_ids.contains(&"p1".to_string()));
        let ssot = read_remote_providers_ssot(&fs, &root, "opencode")
            .await
            .expect("read");
        assert_eq!(ssot.providers.len(), 2);
        let p1 = ssot.providers.iter().find(|p| p.id == "p1").unwrap();
        assert_eq!(p1.name, "P One"); // display_name 取 config.name
        assert_eq!(
            p1.meta.as_ref().and_then(|m| m.live_config_managed),
            Some(true)
        );
        let p2 = ssot.providers.iter().find(|p| p.id == "p2").unwrap();
        assert_eq!(p2.name, "p2"); // 无 name 时回退 id

        // 幂等：再同步不新增
        let (changed2, _) = sync_remote_live_into_ssot(&fs, &root, "opencode", false)
            .await
            .expect("sync2");
        assert_eq!(changed2, 0);
    }

    #[tokio::test]
    async fn sync_additive_preserves_existing_ssot_entries() {
        let root = temp_root("additive-preserve");
        let fs = LocalFileOps;
        // SSOT 已有候选池条目（未在 live 中，如 db-only 供应商）
        let mut ssot = RemoteProvidersSsot::default();
        ssot.providers.push(sample_provider("db-only", "DB Only"));
        write_remote_providers_ssot(&fs, &root, "opencode", &ssot)
            .await
            .expect("seed ssot");
        // live 有一个 provider
        let live = json!({
            "provider": { "p1": { "npm": "@ai-sdk/openai-compatible", "name": "P One" } }
        });
        let path = format!("{root}/.config/opencode/opencode.json");
        std::fs::create_dir_all(std::path::Path::new(&path).parent().unwrap()).unwrap();
        std::fs::write(&path, serde_json::to_string_pretty(&live).unwrap()).unwrap();

        let _ = sync_remote_live_into_ssot(&fs, &root, "opencode", false)
            .await
            .expect("sync");
        let read = read_remote_providers_ssot(&fs, &root, "opencode")
            .await
            .expect("read");
        let ids: Vec<&str> = read.providers.iter().map(|p| p.id.as_str()).collect();
        assert!(ids.contains(&"db-only"));
        assert!(ids.contains(&"p1"));
    }

    #[tokio::test]
    async fn sync_non_additive_imports_default_once() {
        let root = temp_root("noadditive");
        let fs = LocalFileOps;
        let settings_path = format!("{root}/.claude/settings.json");
        std::fs::create_dir_all(std::path::Path::new(&settings_path).parent().unwrap()).unwrap();
        std::fs::write(
            &settings_path,
            r#"{"env":{"ANTHROPIC_BASE_URL":"https://remote.example","ANTHROPIC_AUTH_TOKEN":"sk-1"}}"#,
        )
        .unwrap();

        let (changed, _) = sync_remote_live_into_ssot(&fs, &root, "claude", true)
            .await
            .expect("sync");
        assert_eq!(changed, 1);
        let ssot = read_remote_providers_ssot(&fs, &root, "claude")
            .await
            .expect("read");
        assert_eq!(ssot.current_provider_id.as_deref(), Some("default"));
        assert_eq!(ssot.providers.len(), 1);
        assert_eq!(ssot.providers[0].id, "default");
        assert_eq!(ssot.providers[0].category.as_deref(), Some("custom"));
        assert_eq!(
            ssot.providers[0]
                .settings_config
                .pointer("/env/ANTHROPIC_BASE_URL")
                .and_then(Value::as_str),
            Some("https://remote.example")
        );

        // 非 additive：已有 SSOT 条目且 default 内容一致 → 不再写（幂等）
        let (changed2, _) = sync_remote_live_into_ssot(&fs, &root, "claude", true)
            .await
            .expect("sync2");
        assert_eq!(changed2, 0);
    }

    #[tokio::test]
    async fn sync_non_additive_ensures_default_with_existing_candidates() {
        let root = temp_root("noadditive-candidates");
        let fs = LocalFileOps;
        // 已有候选池（自定义供应商），但无 default
        let mut ssot = RemoteProvidersSsot::default();
        ssot.providers.push(sample_provider("my-vendor", "My Vendor"));
        write_remote_providers_ssot(&fs, &root, "claude", &ssot)
            .await
            .expect("seed");
        // live 有当前配置
        let settings_path = format!("{root}/.claude/settings.json");
        std::fs::create_dir_all(std::path::Path::new(&settings_path).parent().unwrap()).unwrap();
        std::fs::write(
            &settings_path,
            r#"{"env":{"ANTHROPIC_BASE_URL":"https://remote.example"}}"#,
        )
        .unwrap();

        let (changed, _) = sync_remote_live_into_ssot(&fs, &root, "claude", true)
            .await
            .expect("sync");
        assert_eq!(changed, 1); // default 被 upsert（用户要求：随时可见当前机器配置）
        let read = read_remote_providers_ssot(&fs, &root, "claude")
            .await
            .expect("read");
        assert!(read.providers.iter().any(|p| p.id == "default"));
        assert!(read.providers.iter().any(|p| p.id == "my-vendor")); // 候选池保留
        // 已有候选池时不动 current 标记（空库首导才设 default 为 current）
        assert_eq!(read.current_provider_id.as_deref(), None);

        // 幂等：内容一致不再写
        let (changed2, _) = sync_remote_live_into_ssot(&fs, &root, "claude", true)
            .await
            .expect("sync2");
        assert_eq!(changed2, 0);
    }

    #[tokio::test]
    async fn sync_missing_live_is_noop() {
        let root = temp_root("nolive");
        let fs = LocalFileOps;
        let (changed, _) = sync_remote_live_into_ssot(&fs, &root, "claude", true)
            .await
            .expect("sync no live");
        assert_eq!(changed, 0);
        let ssot = read_remote_providers_ssot(&fs, &root, "claude")
            .await
            .expect("read");
        assert!(ssot.providers.is_empty());
    }

    #[tokio::test]
    async fn read_live_ids_openclaw_json5() {
        let root = temp_root("liveids");
        let fs = LocalFileOps;
        // JSON5 语法（无引号键、尾逗号）
        let live = r#"{
            models: {
                providers: {
                    m1: { name: "M1", models: [{ id: "m1-model" }] },
                    m2: { name: "M2", models: [{ id: "m2-model" }] },
                },
            },
        }"#;
        let path = format!("{root}/.openclaw/openclaw.json");
        std::fs::create_dir_all(std::path::Path::new(&path).parent().unwrap()).unwrap();
        std::fs::write(&path, live).unwrap();

        let ids = read_remote_live_provider_ids(&fs, &root, "openclaw")
            .await
            .expect("ids");
        assert!(ids.contains(&"m1".to_string()));
        assert!(ids.contains(&"m2".to_string()));
    }
}
