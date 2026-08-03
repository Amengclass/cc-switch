//! 远端 MCP 服务器管理。
//!
//! 选中远端目标时，MCP 面板直接读/写该主机 `~/.claude.json` 根对象的
//! `mcpServers` 字段（`{ "id": { spec } }`），与远程 settings.json 的处理方式一致：
//! 整文件读 → 改字段 → 原子写回，不经过本地数据库。
//! 通过 `FileOps` 接口同时支持宿主机（SFTP）与容器内（docker exec）。

use serde_json::{json, Value};

use crate::fsops::FileOps;

/// 远端 `~/.claude.json` 路径（`root` 为家目录）。
pub fn remote_claude_json_path(root: &str) -> String {
    format!("{root}/.claude.json")
}

/// 读取远端 `~/.claude.json` 的 `mcpServers` 映射；文件缺失或字段缺失时返回空对象。
pub async fn read_remote_mcp_servers<F: FileOps>(fs: &F, root: &str) -> Result<Value, String> {
    let path = remote_claude_json_path(root);
    match fs.read_text_optional(&path).await? {
        Some(text) => {
            let v: Value = serde_json::from_str(&text)
                .map_err(|e| format!("远端 ~/.claude.json 解析失败: {e}"))?;
            Ok(v
                .pointer("/mcpServers")
                .cloned()
                .unwrap_or_else(|| json!({})))
        }
        None => Ok(json!({})),
    }
}

/// 读取远端 `~/.claude.json` 的**完整内容**（供前端展示/编辑原始 JSON）。
pub async fn read_remote_mcp_json<F: FileOps>(fs: &F, root: &str) -> Result<Value, String> {
    let path = remote_claude_json_path(root);
    match fs.read_text_optional(&path).await? {
        Some(text) => serde_json::from_str(&text)
            .map_err(|e| format!("远端 ~/.claude.json 解析失败: {e}")),
        None => Ok(json!({})),
    }
}

/// 在远端 `~/.claude.json` 的 mcpServers 中新增/更新一个服务器，原子写回。
pub async fn upsert_remote_mcp_server<F: FileOps>(
    fs: &F,
    root: &str,
    id: &str,
    spec: &Value,
) -> Result<(), String> {
    if id.trim().is_empty() {
        return Err("MCP 服务器 ID 不能为空".to_string());
    }
    if !spec.is_object() {
        return Err("MCP 服务器定义必须为 JSON 对象".to_string());
    }

    let mut root_obj = read_remote_mcp_json(fs, root).await?;
    {
        let obj = root_obj
            .as_object_mut()
            .ok_or_else(|| "~/.claude.json 根必须是 JSON 对象".to_string())?;
        if !obj.contains_key("mcpServers") {
            obj.insert("mcpServers".to_string(), json!({}));
        }
    }
    if let Some(servers) = root_obj.get_mut("mcpServers").and_then(|v| v.as_object_mut()) {
        servers.insert(id.to_string(), spec.clone());
    }

    let text = serde_json::to_string_pretty(&root_obj)
        .map_err(|e| format!("序列化 ~/.claude.json 失败: {e}"))?;
    fs.write_text_atomic(&remote_claude_json_path(root), &text).await
}

/// 从远端 `~/.claude.json` 的 mcpServers 中删除一个服务器，原子写回。
pub async fn delete_remote_mcp_server<F: FileOps>(
    fs: &F,
    root: &str,
    id: &str,
) -> Result<bool, String> {
    let mut root_obj = read_remote_mcp_json(fs, root).await?;
    let existed = {
        let Some(servers) = root_obj
            .get_mut("mcpServers")
            .and_then(|v| v.as_object_mut())
        else {
            return Ok(false);
        };
        servers.remove(id).is_some()
    };
    if !existed {
        return Ok(false);
    }

    let text = serde_json::to_string_pretty(&root_obj)
        .map_err(|e| format!("序列化 ~/.claude.json 失败: {e}"))?;
    fs.write_text_atomic(&remote_claude_json_path(root), &text).await?;
    Ok(true)
}
