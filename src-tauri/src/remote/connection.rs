//! SSH 连接与认证(russh 0.62,纯 Rust,无 C 工具链依赖)。

use std::sync::Arc;

use russh::client::{self, Handle};
use russh_sftp::client::SftpSession;
use tokio::io::AsyncReadExt;

use super::{AuthMethod, RemoteHost};

/// 认证时接受任意主机密钥。
/// TODO(M2):引入 known_hosts 校验,防止中间人攻击。
#[derive(Clone, Debug)]
pub struct RemoteHandler;

impl client::Handler for RemoteHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &russh::keys::ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }
}

/// 已建立的远程会话:持有 SSH 通道与 SFTP 句柄。
pub struct RemoteSession {
    pub channel: Handle<RemoteHandler>,
    pub sftp: SftpSession,
}

/// 建立到远程主机的 SSH 连接并初始化 SFTP。
pub async fn connect(host: &RemoteHost, password: Option<&str>) -> Result<RemoteSession, String> {
    let config = Arc::new(client::Config::default());

    let mut channel = client::connect(
        config,
        (host.host.as_str(), host.port),
        RemoteHandler,
    )
    .await
    .map_err(|e| format!("SSH 连接失败 {}:{}: {e}", host.host, host.port))?;

    match host.auth_method {
        AuthMethod::Password => {
            let pw = password.unwrap_or_default();
            let auth = channel
                .authenticate_password(host.username.as_str(), pw)
                .await
                .map_err(|e| format!("认证失败: {e}"))?;
            if !auth.success() {
                return Err("认证失败:服务器拒绝了用户名/密码".to_string());
            }
        }
        AuthMethod::Key => {
            return Err("密钥认证尚未实现(M1 仅支持密码认证)".to_string());
        }
    }

    let sftp_channel = channel
        .channel_open_session()
        .await
        .map_err(|e| format!("打开 SFTP 会话失败: {e}"))?;
    // 关键：必须先在会话通道上请求 `sftp` 子系统，否则服务器不会启动
    // sftp-server，SFTP 版本握手必然超时。
    sftp_channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|e| format!("请求 SFTP 子系统失败: {e}"))?;
    let stream = sftp_channel.into_stream();
    let sftp = SftpSession::new(stream)
        .await
        .map_err(|e| format!("初始化 SFTP 失败: {e}"))?;

    Ok(RemoteSession { channel, sftp })
}

/// 在已建立的 SSH 会话上执行一条远端命令并返回其输出（trim 后）。
///
/// 这是「exec 通道」的封装：让服务器跑命令并把结果拿回来。用于探测远端
/// 环境（如 `command -v claude` 判断 Claude Code 是否安装）。
pub async fn exec_command(
    session: &Handle<RemoteHandler>,
    command: &str,
) -> Result<String, String> {
    let ch = session
        .channel_open_session()
        .await
        .map_err(|e| format!("打开命令通道失败: {e}"))?;
    ch.exec(true, command)
        .await
        .map_err(|e| format!("执行命令失败: {e}"))?;
    let mut stream = ch.into_stream();
    let mut output = Vec::new();
    stream
        .read_to_end(&mut output)
        .await
        .map_err(|e| format!("读取命令输出失败: {e}"))?;
    Ok(String::from_utf8_lossy(&output).trim().to_string())
}

/// 执行命令并通过 stdin 管道传入数据（不嵌入命令字符串，避免大文件撑爆 SSH 通道）。
///
/// 流程：打开通道 → exec 命令 → data() 分块写入 stdin → eof() → 读 stdout。
/// 数据经 base64 编码后写入，远端命令需自行 `base64 -d` 解码。
pub async fn exec_command_with_stdin(
    session: &Handle<RemoteHandler>,
    command: &str,
    stdin_data: &[u8],
) -> Result<String, String> {
    let ch = session
        .channel_open_session()
        .await
        .map_err(|e| format!("打开命令通道失败: {e}"))?;
    ch.exec(true, command)
        .await
        .map_err(|e| format!("执行命令失败: {e}"))?;

    // 分块写入 stdin，每块 64KB
    use tokio::io::AsyncWriteExt;
    const CHUNK: usize = 64 * 1024;
    let mut written = 0usize;
    while written < stdin_data.len() {
        let end = (written + CHUNK).min(stdin_data.len());
        ch.data(&stdin_data[written..end])
            .await
            .map_err(|e| format!("写入 stdin 失败: {e}"))?;
        written = end;
    }
    ch.eof()
        .await
        .map_err(|e| format!("发送 EOF 失败: {e}"))?;

    let mut stream = ch.into_stream();
    let mut output = Vec::new();
    stream
        .read_to_end(&mut output)
        .await
        .map_err(|e| format!("读取命令输出失败: {e}"))?;
    Ok(String::from_utf8_lossy(&output).trim().to_string())
}
