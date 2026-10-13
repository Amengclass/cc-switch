//! 远程会话管理：浏览远端 `~/.claude/projects/*.jsonl`。
//!
//! 通过 `FileOps` 接口支持宿主机（SFTP）与容器内（docker exec）两种数据源。
//! 注意：容器 exec 模式下拿不到文件 metadata（size/mtime），仅提供名称与路径。

use serde::{Deserialize, Serialize};

use std::path::Path;

use crate::fsops::FileOps;
use crate::session_manager::SessionMeta;

/// 远端会话文件信息。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSessionInfo {
    pub path: String,
    pub name: String,
    pub size: Option<u64>,
    pub modified: Option<i64>,
}

/// 列出远端 `~/.claude/projects/` 下全部会话 jsonl 文件。
/// 目录不存在（远端尚未用过 Claude Code）时返回空列表。
pub async fn list_remote_sessions<F: FileOps>(
    fs: &F,
    home: &str,
) -> Result<Vec<RemoteSessionInfo>, String> {
    let projects = format!("{home}/.claude/projects");
    let mut sessions = Vec::new();

    let Ok(dir) = fs.read_dir(&projects).await else {
        return Ok(Vec::new());
    };

    for project in dir {
        if !project.is_dir {
            continue;
        }
        let Ok(sub) = fs.read_dir(&project.path).await else {
            continue;
        };
        for file in sub {
            if !file.name.ends_with(".jsonl") {
                continue;
            }
            sessions.push(RemoteSessionInfo {
                path: file.path,
                name: file.name,
                size: None,
                modified: None,
            });
        }
    }

    Ok(sessions)
}

// ============================================================================
// 远端会话「列表」扫描（FileOps 泛型）：把本机各 provider 的 meta 解析复用到远端
// ============================================================================

/// 递归收集远端目录下满足谓词的文件路径（迭代，避免 async 递归）。
pub async fn collect_files_fs<F: FileOps>(
    fs: &F,
    root: &str,
    pred: impl Fn(&str) -> bool,
) -> Vec<String> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_string()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs.read_dir(&dir).await else {
            continue;
        };
        for e in entries {
            if e.is_dir {
                stack.push(e.path);
            } else if pred(&e.path) {
                out.push(e.path);
            }
        }
    }
    out
}

/// claude：`<root>/**/*.jsonl`，跳过 agent-*/journal。
pub async fn scan_claude_fs<F: FileOps>(fs: &F, root: &str) -> Vec<SessionMeta> {
    use crate::session_manager::providers::claude;
    let files = collect_files_fs(fs, root, |p| p.ends_with(".jsonl")).await;
    let mut out = Vec::new();
    for f in files {
        if claude::is_agent_session(Path::new(&f)) {
            continue;
        }
        if let Ok((head, tail)) = fs.read_head_tail_lines(&f, 10, 30).await {
            if let Some(m) = claude::parse_session_lines(Path::new(&f), head, tail) {
                out.push(m);
            }
        }
    }
    out
}

/// codex：`<root>/**/*.jsonl`。
pub async fn scan_codex_fs<F: FileOps>(fs: &F, root: &str) -> Vec<SessionMeta> {
    use crate::session_manager::providers::codex;
    let files = collect_files_fs(fs, root, |p| p.ends_with(".jsonl")).await;
    let mut out = Vec::new();
    for f in files {
        if let Ok((head, tail)) = fs.read_head_tail_lines(&f, 10, 30).await {
            if let Some(m) = codex::parse_session_lines(
                Path::new(&f),
                head,
                tail,
                &std::collections::HashMap::new(),
            ) {
                out.push(m);
            }
        }
    }
    out
}

/// openclaw：`<root>/**/*.jsonl`。
pub async fn scan_openclaw_fs<F: FileOps>(fs: &F, root: &str) -> Vec<SessionMeta> {
    use crate::session_manager::providers::openclaw;
    let files = collect_files_fs(fs, root, |p| p.ends_with(".jsonl")).await;
    let mut out = Vec::new();
    for f in files {
        if let Ok((head, tail)) = fs.read_head_tail_lines(&f, 10, 30).await {
            if let Some(m) = openclaw::parse_session_lines(Path::new(&f), head, tail, None) {
                out.push(m);
            }
        }
    }
    out
}

/// grokbuild：`<root>/**/summary.json`（读文本构建）。
pub async fn scan_grokbuild_fs<F: FileOps>(fs: &F, root: &str) -> Vec<SessionMeta> {
    use crate::session_manager::providers::grokbuild;
    let files = collect_files_fs(fs, root, |p| p.ends_with("summary.json")).await;
    let mut out = Vec::new();
    for f in files {
        if let Ok(Some(text)) = fs.read_text_optional(&f).await {
            if let Some(m) = grokbuild::parse_summary_text(&text, Path::new(&f)) {
                out.push(m);
            }
        }
    }
    out
}

/// gemini：`<root>/<project>/chats/*.json`（同名 .jsonl 存在则跳过）。
pub async fn scan_gemini_fs<F: FileOps>(fs: &F, root: &str) -> Vec<SessionMeta> {
    use crate::session_manager::providers::gemini;
    let files = collect_files_fs(fs, root, |p| p.ends_with(".json")).await;
    let mut out = Vec::new();
    for f in files {
        let jsonl = format!("{}.jsonl", &f[..f.len() - ".json".len()]);
        if fs.exists(&jsonl).await {
            continue;
        }
        if let Ok(Some(text)) = fs.read_text_optional(&f).await {
            if let Some(m) = gemini::parse_session_from_text(Path::new(&f), &text) {
                out.push(m);
            }
        }
    }
    out
}

/// pi：`<root>/**/*.jsonl`（读文本构建会话树）。
pub async fn scan_pi_fs<F: FileOps>(fs: &F, root: &str) -> Vec<SessionMeta> {
    use crate::session_manager::providers::pi;
    let files = collect_files_fs(fs, root, |p| p.ends_with(".jsonl")).await;
    let mut out = Vec::new();
    for f in files {
        if let Ok(Some(text)) = fs.read_text_optional(&f).await {
            if let Ok(m) = pi::parse_session_from_content(Path::new(&f), &text) {
                out.push(m);
            }
        }
    }
    out
}
