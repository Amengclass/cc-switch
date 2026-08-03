//! 远程主机「当前生效供应商」的持久化。
//!
//! 原生 cc switch 判断「当前供应商」用的是持久化的 settings（`get_effective_current_provider`
//! 读 DB / 配置），而不是靠比对 base_url。远程侧为保持同一语义，在每次
//! `switch_remote_provider` 成功时记录 `host_id -> provider_id` 到
//! `~/.cc-switch/remote_current_providers.json`。
//!
//! `get_remote_current_provider` 优先返回该记录（纯本地读，无需 SSH），
//! base_url 匹配仅作老数据（本应用切换前已生效的远端）的兜底。

use std::collections::HashMap;
use std::path::PathBuf;

fn store_path() -> Result<PathBuf, String> {
    Ok(crate::config::get_app_config_dir().join("remote_current_providers.json"))
}

/// 记录某主机的当前生效供应商。
pub fn save_current_provider(host_id: &str, provider_id: &str) -> Result<(), String> {
    let mut map = load_map()?;
    map.insert(host_id.to_string(), provider_id.to_string());
    write_map(&map)
}

/// 读取某主机的当前生效供应商；未记录时返回 None。
pub fn get_current_provider(host_id: &str) -> Result<Option<String>, String> {
    Ok(load_map()?.get(host_id).cloned())
}

/// 删除某主机的记录（删除主机时清理）。
pub fn delete_current_provider(host_id: &str) -> Result<(), String> {
    let mut map = load_map()?;
    if map.remove(host_id).is_some() {
        write_map(&map)?;
    }
    Ok(())
}

fn load_map() -> Result<HashMap<String, String>, String> {
    let path = store_path()?;
    if !path.exists() {
        return Ok(HashMap::new());
    }
    let text = std::fs::read_to_string(&path).map_err(|e| format!("读取当前供应商文件失败: {e}"))?;
    serde_json::from_str(&text).map_err(|e| format!("解析当前供应商文件失败: {e}"))
}

fn write_map(map: &HashMap<String, String>) -> Result<(), String> {
    let path = store_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
    }
    let text =
        serde_json::to_string_pretty(map).map_err(|e| format!("序列化当前供应商文件失败: {e}"))?;
    std::fs::write(&path, text).map_err(|e| format!("写入当前供应商文件失败: {e}"))
}
