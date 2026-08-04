//! 远端 Prompts 管理。
//!
//! 与本地完全对称：`~/.cc-switch/prompts.json` 存多提示词列表，
//! 启用那条写入 `~/.claude/CLAUDE.md`。通过 `FileOps` 支持宿主机（SFTP）与容器（docker exec）。

use crate::fsops::FileOps;
use crate::prompt::Prompt;

/// 远端 CLAUDE.md 路径。
pub fn remote_prompt_path(root: &str) -> String {
    format!("{root}/.claude/CLAUDE.md")
}

/// 远端 prompts.json 路径。
pub fn remote_prompts_json_path(root: &str) -> String {
    format!("{root}/.cc-switch/prompts.json")
}

/// 读取远端 CLAUDE.md 内容；文件缺失时返回空字符串。
pub async fn read_remote_prompt<F: FileOps>(fs: &F, root: &str) -> Result<String, String> {
    let path = remote_prompt_path(root);
    Ok(fs.read_text_optional(&path).await?.unwrap_or_default())
}

/// 将内容原子写回远端 CLAUDE.md。
pub async fn write_remote_prompt<F: FileOps>(fs: &F, root: &str, content: &str) -> Result<(), String> {
    fs.write_text_atomic(&remote_prompt_path(root), content).await
}

/// 读远端 prompts.json 列表。
pub async fn read_remote_prompts<F: FileOps>(fs: &F, root: &str) -> Result<Vec<Prompt>, String> {
    let path = remote_prompts_json_path(root);
    match fs.read_text_optional(&path).await? {
        Some(text) if !text.trim().is_empty() => {
            serde_json::from_str(&text).map_err(|e| format!("解析 prompts.json 失败: {e}"))
        }
        _ => Ok(Vec::new()),
    }
}

/// 原子写远端 prompts.json + 同步启用提示词到 CLAUDE.md。
pub async fn write_remote_prompts<F: FileOps>(
    fs: &F,
    root: &str,
    prompts: &[Prompt],
) -> Result<(), String> {
    let json = serde_json::to_string_pretty(prompts)
        .map_err(|e| format!("序列化 prompts.json 失败: {e}"))?;
    let path = remote_prompts_json_path(root);
    fs.write_text_atomic(&path, &json).await?;

    // 启用的提示词写入 CLAUDE.md
    let live_content = prompts.iter()
        .find(|p| p.enabled)
        .map(|p| p.content.as_str())
        .unwrap_or("");
    write_remote_prompt(fs, root, live_content).await
}
