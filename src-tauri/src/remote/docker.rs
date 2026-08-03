//! Docker 容器内的文件操作（`DockerExecFileOps`）。
//!
//! 容器内的配置文件（如 `~/.claude/settings.json`）不在宿主机文件系统里，
//! SFTP 够不到，必须通过 `docker exec` 在容器内跑 shell 命令读写。
//! 本模块实现 `FileOps` trait 的第三种数据源（Local = 本机 / SFTP = 宿主机 /
//! Docker exec = 容器内），让 settings/MCP/Prompts/Skills 业务逻辑在容器内直接复用。

use russh::client::Handle;
use russh_sftp::client::SftpSession;

use crate::fsops::{DirEntry, FileOps};

use super::connection::{exec_command, RemoteHandler};

/// 统一的数据源包装：宿主机（SFTP）或容器内（docker exec）。
/// 命令层构造一个 `RemoteTarget`，业务函数按 `FileOps` 泛型使用，
/// 不需要关心背后是哪种实现。
pub enum RemoteTarget<'a> {
    Sftp(crate::fsops::RemoteSftpFileOps<'a>),
    Docker(DockerExecFileOps<'a>),
}

impl<'a> RemoteTarget<'a> {
    /// 构造目标数据源。`container` 为 Some 时走容器内，否则走宿主机 SFTP。
    pub fn new(
        sftp: &'a SftpSession,
        channel: &'a Handle<RemoteHandler>,
        container: Option<&str>,
    ) -> Result<Self, String> {
        match container {
            Some(c) => Ok(RemoteTarget::Docker(DockerExecFileOps::new(channel, c)?)),
            None => Ok(RemoteTarget::Sftp(crate::fsops::RemoteSftpFileOps {
                sftp,
            })),
        }
    }

    /// 获取底层 SFTP 句柄（仅宿主机模式可用，供 zip 安装等二进制写场景）。
    pub fn sftp(&self) -> Option<&'a SftpSession> {
        match self {
            RemoteTarget::Sftp(f) => Some(f.sftp),
            RemoteTarget::Docker(_) => None,
        }
    }
}

impl FileOps for RemoteTarget<'_> {
    async fn exists(&self, path: &str) -> bool {
        match self {
            RemoteTarget::Sftp(f) => f.exists(path).await,
            RemoteTarget::Docker(f) => f.exists(path).await,
        }
    }

    async fn is_dir(&self, path: &str) -> bool {
        match self {
            RemoteTarget::Sftp(f) => f.is_dir(path).await,
            RemoteTarget::Docker(f) => f.is_dir(path).await,
        }
    }

    async fn read_head_tail_lines(
        &self,
        path: &str,
        head_n: usize,
        tail_n: usize,
    ) -> Result<(Vec<String>, Vec<String>), String> {
        match self {
            RemoteTarget::Sftp(f) => f.read_head_tail_lines(path, head_n, tail_n).await,
            RemoteTarget::Docker(f) => f.read_head_tail_lines(path, head_n, tail_n).await,
        }
    }

    async fn read_dir(&self, path: &str) -> Result<Vec<DirEntry>, String> {
        match self {
            RemoteTarget::Sftp(f) => f.read_dir(path).await,
            RemoteTarget::Docker(f) => f.read_dir(path).await,
        }
    }

    async fn remove_file(&self, path: &str) -> Result<(), String> {
        match self {
            RemoteTarget::Sftp(f) => f.remove_file(path).await,
            RemoteTarget::Docker(f) => f.remove_file(path).await,
        }
    }

    async fn remove_dir_all(&self, path: &str) -> Result<(), String> {
        match self {
            RemoteTarget::Sftp(f) => f.remove_dir_all(path).await,
            RemoteTarget::Docker(f) => f.remove_dir_all(path).await,
        }
    }

    async fn read_text_optional(&self, path: &str) -> Result<Option<String>, String> {
        match self {
            RemoteTarget::Sftp(f) => f.read_text_optional(path).await,
            RemoteTarget::Docker(f) => f.read_text_optional(path).await,
        }
    }

    async fn write_text_atomic(&self, path: &str, content: &str) -> Result<(), String> {
        match self {
            RemoteTarget::Sftp(f) => f.write_text_atomic(path, content).await,
            RemoteTarget::Docker(f) => f.write_text_atomic(path, content).await,
        }
    }
}

/// 容器内文件操作：每个方法都通过 `docker exec <container> sh -c '<cmd>'` 封装。
///
/// 借用 `&Handle` 而非持有：`exec_command` 每次调用时才 `channel_open_session`，
/// 命令调用方可以同时借用 `channel`（exec）与 `sftp`（需要时）。
pub struct DockerExecFileOps<'a> {
    pub channel: &'a Handle<RemoteHandler>,
    pub container: String,
}

impl<'a> DockerExecFileOps<'a> {
    /// 构造容器名：只允许单段（容器名不包含路径分隔符）。
    pub fn new(channel: &'a Handle<RemoteHandler>, container: &str) -> Result<Self, String> {
        if container.is_empty()
            || container.contains('/')
            || container.contains('\\')
            || container.contains(' ')
            || container.contains(';')
            || container.contains('$')
            || container.contains('`')
            || container.contains('&')
            || container.contains('|')
            || container.contains('>')
            || container.contains('<')
        {
            return Err("非法容器名".to_string());
        }
        Ok(Self {
            channel,
            container: container.to_string(),
        })
    }

    async fn exec(&self, shell_cmd: &str) -> Result<String, String> {
        exec_command(self.channel, &format!("docker exec {} sh -c {}", self.container, shell_quote(shell_cmd))).await
    }
}

impl FileOps for DockerExecFileOps<'_> {
    async fn exists(&self, path: &str) -> bool {
        self.exec(&format!("test -e {}", shell_quote(path)))
            .await
            .is_ok()
    }

    async fn is_dir(&self, path: &str) -> bool {
        self.exec(&format!("test -d {}", shell_quote(path)))
            .await
            .is_ok()
    }

    async fn read_head_tail_lines(
        &self,
        path: &str,
        head_n: usize,
        tail_n: usize,
    ) -> Result<(Vec<String>, Vec<String>), String> {
        // 会话文件可能很大，只取头尾：用 awk/sed 分别截取
        let head = self
            .exec(&format!("head -n {} {}", head_n, shell_quote(path)))
            .await
            .map(|s| s.lines().map(|l| l.to_string()).collect())
            .unwrap_or_default();
        let tail = self
            .exec(&format!("tail -n {} {}", tail_n, shell_quote(path)))
            .await
            .map(|s| s.lines().map(|l| l.to_string()).collect())
            .unwrap_or_default();
        Ok((head, tail))
    }

    async fn read_dir(&self, path: &str) -> Result<Vec<DirEntry>, String> {
        // ls -A 输出纯名称；再对每项探测是否目录
        let out = self
            .exec(&format!("ls -A {}", shell_quote(path)))
            .await
            .map_err(|e| format!("容器内读取目录失败 {path}: {e}"))?;
        let mut entries = Vec::new();
        for name in out.lines() {
            let name = name.trim().to_string();
            if name.is_empty() {
                continue;
            }
            let full = format!("{}/{}", path.trim_end_matches('/'), name);
            let is_dir = self.exec(&format!("test -d {}", shell_quote(&full))).await.is_ok();
            entries.push(DirEntry {
                name,
                path: full,
                is_dir,
            });
        }
        Ok(entries)
    }

    async fn remove_file(&self, path: &str) -> Result<(), String> {
        self.exec(&format!("rm -f {}", shell_quote(path)))
            .await
            .map_err(|e| format!("容器内删除文件失败 {path}: {e}"))?;
        Ok(())
    }

    async fn remove_dir_all(&self, path: &str) -> Result<(), String> {
        self.exec(&format!("rm -rf {}", shell_quote(path)))
            .await
            .map_err(|e| format!("容器内删除目录失败 {path}: {e}"))?;
        Ok(())
    }

    async fn read_text_optional(&self, path: &str) -> Result<Option<String>, String> {
        if !self.exists(path).await {
            return Ok(None);
        }
        self.exec(&format!("cat {}", shell_quote(path)))
            .await
            .map(Some)
            .map_err(|e| format!("容器内读取文件失败 {path}: {e}"))
    }

    async fn write_text_atomic(&self, path: &str, content: &str) -> Result<(), String> {
        // 容器内原子写：父目录就绪 → 写临时文件 → mv 覆盖。
        // 内容经 base64 编码传进 sh，避免引号/换行/JSON 特殊字符破坏命令。
        use base64::Engine as _;
        let b64 = base64::engine::general_purpose::STANDARD.encode(content.as_bytes());

        let parent = match path.rsplit_once('/') {
            Some((d, _)) if !d.is_empty() => d,
            _ => "/",
        };
        let tmp = format!("{}.ccswitch.tmp", path);

        let script = format!(
            "mkdir -p {parent} && echo {b64} | base64 -d > {tmp} && mv {tmp} {path}",
            parent = shell_quote(parent),
            b64 = b64,
            tmp = shell_quote(&tmp),
            path = shell_quote(path),
        );
        let _ = self.exec(&script).await?;
        Ok(())
    }
}

/// 把参数安全地包进单引号（shell 转义）：单引号内一切字面化，无需担心特殊字符。
/// 参数本身若含单引号则拒绝（路径/容器名不会含）。
fn shell_quote(s: &str) -> String {
    if s.contains('\'') {
        // 极少见；用双引号兜底但加一层转义
        format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
    } else {
        format!("'{s}'")
    }
}

/// 通过 `docker ps` 列出容器（id + 名称），供前端选择。
pub async fn list_docker_containers(channel: &Handle<RemoteHandler>) -> Result<Vec<String>, String> {
    // --format 输出 "id\tname"；name 取最后一个（--format '{{.Names}}' 已是逗号分隔，取第一个即可）
    let out = exec_command(channel, "docker ps --format '{{.ID}} {{.Names}}'").await?;
    let mut containers = Vec::new();
    for line in out.lines() {
        let mut parts = line.split_whitespace();
        if let (Some(_id), Some(names)) = (parts.next(), parts.next()) {
            // Names 可能是逗号分隔的多个；取第一个作为容器名
            let name = names.split(',').next().unwrap_or("").to_string();
            if !name.is_empty() {
                containers.push(name);
            }
        }
    }
    Ok(containers)
}
