//! SSH 远程主机管理模块。
//!
//! 让用户在本机 GUI 中连接 Linux 服务器,直接读写远端 `~/.claude/settings.json`,
//! 执行供应商切换(原子写回)、冲突环境变量清理,并明确提示切换生效方式。
//!
//! 里程碑:M1 骨架(类型 + 模块声明)→ M2 连接/读配置 → M3 切换写回 → M4 env 清理 → M5 远程会话。

pub mod codex;
pub mod commands;
pub mod connection;
pub mod credentials;
pub mod current;
pub mod docker;
pub mod effect;
pub mod env_clean;
pub mod mcp;
pub mod prompt;
pub mod sessions;
pub mod settings;
pub mod sftp_io;
pub mod skill;

use serde::{Deserialize, Serialize};

/// 批量 toggle 的逐条结果,形状对齐前端 `SequentialBulkActionResult`。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteBulkToggleResult {
    pub succeeded: Vec<String>,
    pub failed: Vec<RemoteBulkToggleFailure>,
}

/// 批量 toggle 中单条失败项。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteBulkToggleFailure {
    pub item: String,
    pub error: String,
}

/// 认证方式(M1 仅支持密码,密钥在二期实现)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AuthMethod {
    Password,
    Key,
}

/// 一台可管理的远程主机。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteHost {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_method: AuthMethod,
    /// 是否把密码保存进系统钥匙串(用于下次一键连接)。
    pub save_password: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

impl RemoteHost {
    /// 远端用户主目录的默认推导。
    /// TODO(M3):优先通过 SSH 执行 `echo $HOME` 在连接时探测,此值仅作兜底。
    pub fn default_home(&self) -> String {
        if self.username == "root" {
            "/root".to_string()
        } else {
            format!("/home/{}", self.username)
        }
    }
}
