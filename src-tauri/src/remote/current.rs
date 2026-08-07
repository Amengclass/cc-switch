//! 远程主机「当前生效供应商」的持久化（per-app）。
//!
//! 原生 cc switch 判断「当前供应商」用的是持久化的 settings（`get_effective_current_provider`
//! 读 DB / 配置），而不是靠比对 base_url。远程侧为保持同一语义，在每次
//! `switch_remote_provider` 成功时记录 `host_id -> { app -> provider_id }` 到
//! `~/.cc-switch/remote_current_providers.json`。
//!
//! `get_remote_current_provider` 优先返回该记录（纯本地读，无需 SSH），
//! base_url 匹配仅作老数据（本应用切换前已生效的远端）的兜底。
//!
//! **数据格式**：`{ "<host_id>": { "<app>": "<provider_id>" } }`。
//! 兼容旧格式 `{ "<host_id>": "<provider_id>" }`：加载时把字符串值视为
//! claude 的 provider（历史版本只有 claude 远程）。

use std::collections::HashMap;
use std::path::PathBuf;

fn store_path() -> Result<PathBuf, String> {
    Ok(crate::config::get_app_config_dir().join("remote_current_providers.json"))
}

/// 记录某主机的当前生效供应商（per-app）。
pub fn save_current_provider(host_id: &str, app: &str, provider_id: &str) -> Result<(), String> {
    let mut map = load_map()?;
    let entry = map.entry(host_id.to_string()).or_default();
    entry.insert(app.to_string(), provider_id.to_string());
    write_map(&map)
}

/// 读取某主机、某 app 的当前生效供应商；未记录时返回 None。
pub fn get_current_provider(host_id: &str, app: &str) -> Result<Option<String>, String> {
    Ok(load_map()?.get(host_id).and_then(|m| m.get(app)).cloned())
}

/// 删除某主机的全部记录（删除主机时清理）。
pub fn delete_current_provider(host_id: &str) -> Result<(), String> {
    let mut map = load_map()?;
    if map.remove(host_id).is_some() {
        write_map(&map)?;
    }
    Ok(())
}

/// 删除某主机、某 app 的当前供应商记录（删除/移除供应商时清理；
/// app 记录删空则一并移除 host 键）。
pub fn delete_current_provider_for_app(host_id: &str, app: &str) -> Result<(), String> {
    let mut map = load_map()?;
    let mut changed = false;
    if let Some(apps) = map.get_mut(host_id) {
        if apps.remove(app).is_some() {
            changed = true;
            if apps.is_empty() {
                map.remove(host_id);
            }
        }
    }
    if changed {
        write_map(&map)?;
    }
    Ok(())
}

/// 内部结构：host -> { app -> provider_id }
type Store = HashMap<String, HashMap<String, String>>;

fn load_map() -> Result<Store, String> {
    let path = store_path()?;
    if !path.exists() {
        return Ok(HashMap::new());
    }
    let text = std::fs::read_to_string(&path).map_err(|e| format!("读取当前供应商文件失败: {e}"))?;
    let raw: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| format!("解析当前供应商文件失败: {e}"))?;

    // 兼容旧格式：host -> "provider_id"（历史版本只有 claude 远程）
    if let Some(obj) = raw.as_object() {
        if obj.values().all(|v| v.is_string()) {
            let mut map: Store = HashMap::new();
            for (host, v) in obj {
                if let Some(id) = v.as_str() {
                    let mut apps = HashMap::new();
                    apps.insert("claude".to_string(), id.to_string());
                    map.insert(host.clone(), apps);
                }
            }
            return Ok(map);
        }
    }

    serde_json::from_value(raw).map_err(|e| format!("解析当前供应商文件失败: {e}"))
}

fn write_map(map: &Store) -> Result<(), String> {
    let path = store_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
    }
    let text =
        serde_json::to_string_pretty(map).map_err(|e| format!("序列化当前供应商文件失败: {e}"))?;
    std::fs::write(&path, text).map_err(|e| format!("写入当前供应商文件失败: {e}"))
}
