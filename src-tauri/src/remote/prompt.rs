//! 远端 Prompts（CLAUDE.md）管理。
//!
//! 选中远端目标时，Prompts 面板直接读写该主机 `~/.claude/CLAUDE.md`（Claude Code
//! 的提示词 live 文件）。远端没有本地 DB 的「多提示词 + 启用」结构，因此整文件读写，
//! 与远程 settings.json / mcpServers 的处理方式一致。通过 `FileOps` 接口同时支持
//! 宿主机（SFTP）与容器内（docker exec）。

use crate::fsops::FileOps;

/// 远端 CLAUDE.md 路径（`root` 为家目录）。
pub fn remote_prompt_path(root: &str) -> String {
    format!("{root}/.claude/CLAUDE.md")
}

/// 读取远端 CLAUDE.md 内容；文件缺失时返回空字符串。
pub async fn read_remote_prompt<F: FileOps>(fs: &F, root: &str) -> Result<String, String> {
    let path = remote_prompt_path(root);
    Ok(fs.read_text_optional(&path).await?.unwrap_or_default())
}

/// 将内容整文件原子写回远端 CLAUDE.md。
pub async fn write_remote_prompt<F: FileOps>(
    fs: &F,
    root: &str,
    content: &str,
) -> Result<(), String> {
    fs.write_text_atomic(&remote_prompt_path(root), content).await
}
