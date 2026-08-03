//! 文件操作抽象：本机走 `std::fs`，远端走 SFTP。
//!
//! 让 session / prompt / mcp / skill 等逻辑只依赖 `FileOps` 接口，
//! 通过传入 `LocalFileOps`（本机）或 `RemoteSftpFileOps`（远端）实现「同一套逻辑、两套数据源」。

use std::path::Path;

use russh_sftp::client::SftpSession;
use tokio::io::AsyncReadExt;

/// 目录项。
#[derive(Debug, Clone)]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

/// 文件操作接口（异步，远端 SFTP / docker exec 需要 await）。
pub trait FileOps {
    async fn exists(&self, path: &str) -> bool;
    async fn is_dir(&self, path: &str) -> bool;
    async fn read_head_tail_lines(
        &self,
        path: &str,
        head_n: usize,
        tail_n: usize,
    ) -> Result<(Vec<String>, Vec<String>), String>;
    async fn read_dir(&self, path: &str) -> Result<Vec<DirEntry>, String>;
    async fn remove_file(&self, path: &str) -> Result<(), String>;
    async fn remove_dir_all(&self, path: &str) -> Result<(), String>;
    /// 读取整个文本文件；文件不存在时返回 None。
    async fn read_text_optional(&self, path: &str) -> Result<Option<String>, String>;
    /// 原子写回整个文本文件（临时文件 + rename），自动确保父目录存在。
    async fn write_text_atomic(&self, path: &str, content: &str) -> Result<(), String>;
}

/// 本机实现：直接走 std::fs。
pub struct LocalFileOps;

impl FileOps for LocalFileOps {
    async fn exists(&self, path: &str) -> bool {
        Path::new(path).exists()
    }

    async fn is_dir(&self, path: &str) -> bool {
        Path::new(path).is_dir()
    }

    async fn read_head_tail_lines(
        &self,
        path: &str,
        head_n: usize,
        tail_n: usize,
    ) -> Result<(Vec<String>, Vec<String>), String> {
        crate::session_manager::providers::utils::read_head_tail_lines(
            Path::new(path),
            head_n,
            tail_n,
        )
        .map_err(|e| e.to_string())
    }

    async fn read_dir(&self, path: &str) -> Result<Vec<DirEntry>, String> {
        let entries = std::fs::read_dir(path).map_err(|e| format!("读取目录失败 {path}: {e}"))?;
        let mut out = Vec::new();
        for entry in entries.flatten() {
            let p = entry.path();
            out.push(DirEntry {
                name: p
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default(),
                path: p.to_string_lossy().to_string(),
                is_dir: p.is_dir(),
            });
        }
        Ok(out)
    }

    async fn remove_file(&self, path: &str) -> Result<(), String> {
        std::fs::remove_file(path).map_err(|e| format!("删除文件失败 {path}: {e}"))
    }

    async fn remove_dir_all(&self, path: &str) -> Result<(), String> {
        std::fs::remove_dir_all(path).map_err(|e| format!("删除目录失败 {path}: {e}"))
    }

    async fn read_text_optional(&self, path: &str) -> Result<Option<String>, String> {
        let p = Path::new(path);
        if !p.exists() {
            return Ok(None);
        }
        std::fs::read_to_string(p)
            .map(Some)
            .map_err(|e| format!("读取文件失败 {path}: {e}"))
    }

    async fn write_text_atomic(&self, path: &str, content: &str) -> Result<(), String> {
        let p = Path::new(path);
        if let Some(parent) = p.parent().filter(|d| !d.as_os_str().is_empty()) {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("创建目录失败 {}: {e}", parent.display()))?;
        }
        crate::config::write_text_file(p, content)
            .map_err(|e| format!("写入文件失败 {path}: {e}"))
    }
}

/// 远端实现：走 SFTP。
pub struct RemoteSftpFileOps<'a> {
    pub sftp: &'a SftpSession,
}

/// 从文件内容里取头/尾行（纯函数，供本机与远端共用）。
pub fn split_head_tail(content: &str, head_n: usize, tail_n: usize) -> (Vec<String>, Vec<String>) {
    let all: Vec<String> = content.lines().map(|s| s.to_string()).collect();
    let head = all.iter().take(head_n).cloned().collect();
    let skip = all.len().saturating_sub(tail_n);
    let tail = all.into_iter().skip(skip).collect();
    (head, tail)
}

impl FileOps for RemoteSftpFileOps<'_> {
    async fn exists(&self, path: &str) -> bool {
        self.sftp.try_exists(path).await.unwrap_or(false)
    }

    async fn is_dir(&self, path: &str) -> bool {
        self.sftp
            .metadata(path)
            .await
            .map(|m| m.file_type().is_dir())
            .unwrap_or(false)
    }

    async fn read_head_tail_lines(
        &self,
        path: &str,
        head_n: usize,
        tail_n: usize,
    ) -> Result<(Vec<String>, Vec<String>), String> {
        let data = self
            .sftp
            .read(path)
            .await
            .map_err(|e| format!("远端读取失败 {path}: {e}"))?;
        let content = String::from_utf8_lossy(&data);
        Ok(split_head_tail(&content, head_n, tail_n))
    }

    async fn read_dir(&self, path: &str) -> Result<Vec<DirEntry>, String> {
        let dir = self
            .sftp
            .read_dir(path)
            .await
            .map_err(|e| format!("远端读取目录失败 {path}: {e}"))?;
        let mut out = Vec::new();
        for entry in dir {
            out.push(DirEntry {
                name: entry.file_name(),
                path: entry.path(),
                is_dir: entry.file_type().is_dir(),
            });
        }
        Ok(out)
    }

    async fn remove_file(&self, path: &str) -> Result<(), String> {
        self.sftp
            .remove_file(path)
            .await
            .map_err(|e| format!("远端删除文件失败 {path}: {e}"))
    }

    async fn remove_dir_all(&self, path: &str) -> Result<(), String> {
        // 远端递归删除：先删内容再删目录本身
        let dir = self.read_dir(path).await?;
        for entry in dir {
            let p = entry.path;
            if entry.is_dir {
                Box::pin(self.remove_dir_all(&p)).await?;
            } else {
                self.remove_file(&p).await?;
            }
        }
        self.sftp
            .remove_dir(path)
            .await
            .map_err(|e| format!("远端删除目录失败 {path}: {e}"))
    }

    async fn read_text_optional(&self, path: &str) -> Result<Option<String>, String> {
        crate::remote::sftp_io::read_remote_text_optional(self.sftp, path).await
    }

    async fn write_text_atomic(&self, path: &str, content: &str) -> Result<(), String> {
        crate::remote::sftp_io::write_remote_text_atomic(self.sftp, path, content).await
    }
}
