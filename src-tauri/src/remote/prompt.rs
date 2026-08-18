//! 远端 Prompts 管理。
//!
//! 与本地完全对称：`~/.cc-switch/prompts.json`（claude）或
//! `~/.cc-switch/prompts-{app}.json`（其余 app）存多提示词列表，
//! 启用那条写入各 app 的 live 提示词文件。通过 `FileOps` 支持宿主机（SFTP）与容器（docker exec）。
//!
//! live 文件路径与本机 `prompt_files::prompt_file_path` 矩阵一致：
//! claude `~/.claude/CLAUDE.md`、codex `~/.codex/AGENTS.md`、
//! gemini `~/.gemini/GEMINI.md`、grok `~/.grok/AGENTS.md`、
//! opencode `~/.config/opencode/AGENTS.md`、openclaw `~/.openclaw/AGENTS.md`、
//! hermes `~/.hermes/SOUL.md`（远端路径忽略本机 override 设置，按 home 直拼）。

use crate::fsops::FileOps;
use crate::prompt::Prompt;

/// 各 app 的远端 live 提示词文件路径。
pub fn remote_prompt_path(root: &str, app: &str) -> String {
    let (dir, file) = match app {
        "codex" => (".codex", "AGENTS.md"),
        "gemini" => (".gemini", "GEMINI.md"),
        "grokbuild" => (".grok", "AGENTS.md"),
        "opencode" => (".config/opencode", "AGENTS.md"),
        "openclaw" => (".openclaw", "AGENTS.md"),
        "hermes" => (".hermes", "SOUL.md"),
        "pi" => (".pi/agent", "AGENTS.md"),
        _ => (".claude", "CLAUDE.md"),
    };
    format!("{root}/{dir}/{file}")
}

/// 远端 prompts.json 路径（claude 保持 `prompts.json` 兼容老数据，其余 per-app）。
pub fn remote_prompts_json_path(root: &str, app: &str) -> String {
    if app == "claude" {
        format!("{root}/.cc-switch/prompts.json")
    } else {
        format!("{root}/.cc-switch/prompts-{app}.json")
    }
}

/// 读取远端 live 提示词文件内容；文件缺失时返回空字符串。
pub async fn read_remote_prompt<F: FileOps>(
    fs: &F,
    root: &str,
    app: &str,
) -> Result<String, String> {
    let path = remote_prompt_path(root, app);
    Ok(fs.read_text_optional(&path).await?.unwrap_or_default())
}

/// 将内容原子写回远端 live 提示词文件。
pub async fn write_remote_prompt<F: FileOps>(
    fs: &F,
    root: &str,
    app: &str,
    content: &str,
) -> Result<(), String> {
    fs.write_text_atomic(&remote_prompt_path(root, app), content)
        .await
}

/// 读远端 prompts.json 列表。
pub async fn read_remote_prompts<F: FileOps>(
    fs: &F,
    root: &str,
    app: &str,
) -> Result<Vec<Prompt>, String> {
    let path = remote_prompts_json_path(root, app);
    match fs.read_text_optional(&path).await? {
        Some(text) if !text.trim().is_empty() => {
            serde_json::from_str(&text).map_err(|e| format!("解析 {path} 失败: {e}"))
        }
        _ => Ok(Vec::new()),
    }
}

/// 原子写远端 prompts.json + 同步启用提示词到 live 提示词文件。
pub async fn write_remote_prompts<F: FileOps>(
    fs: &F,
    root: &str,
    app: &str,
    prompts: &[Prompt],
) -> Result<(), String> {
    let json = serde_json::to_string_pretty(prompts)
        .map_err(|e| format!("序列化 prompts.json 失败: {e}"))?;
    let path = remote_prompts_json_path(root, app);
    fs.write_text_atomic(&path, &json).await?;

    // 启用的提示词写入 live 提示词文件
    let live_content = prompts
        .iter()
        .find(|p| p.enabled)
        .map(|p| p.content.as_str())
        .unwrap_or("");
    write_remote_prompt(fs, root, app, live_content).await
}
