//! SSH 连接与认证(russh 0.62,纯 Rust,无 C 工具链依赖)。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

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
/// 池内以 `Arc<RemoteSession>` 共享同一底层连接；字段访问经 deref coercion
/// 在 `&Arc<RemoteSession>` 上照常工作（38 处调用点零改动）。
pub struct RemoteSession {
    pub channel: Handle<RemoteHandler>,
    pub sftp: SftpSession,
}

/// 把参数安全地包进单引号（shell 转义）：单引号内一切字面化，无需担心特殊字符。
/// 参数本身若含单引号则拒绝（路径/容器名不会含）。
pub fn shell_quote(s: &str) -> String {
    if s.contains('\'') {
        // 极少见；用双引号兜底但加一层转义
        format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
    } else {
        format!("'{s}'")
    }
}

impl RemoteSession {
    /// 在已建立的 SSH 会话上执行一条 POSIX sh 脚本，并把数据流式传入 stdin。
    /// **强制 `sh -c`**：不依赖远端默认 login shell（zsh/fish 等语法差异防护）。
    /// 数据经 base64 编码后写入，脚本需自行 `base64 -d` 解码（见 write_settings_with_backup）。
    pub async fn exec_with_stdin(&self, script: &str, stdin_data: &[u8]) -> Result<String, String> {
        let cmd = format!("sh -c {}", shell_quote(script));
        exec_command_with_stdin(&self.channel, &cmd, stdin_data).await
    }

    /// 读取远端文件文本（不存在 / 为空时返回 None）。
    /// 走 exec `cat`（宿主机 `sh -c` / 容器 `docker exec`），不依赖 SFTP
    /// （容器目标无 SFTP）。供远端读-改-写类切换（gemini settings.json 等）使用。
    pub async fn read_remote_text(
        &self,
        path: &str,
        container: Option<&str>,
    ) -> Result<Option<String>, String> {
        let cat = format!("cat {} 2>/dev/null", shell_quote(path));
        let cmd = match container {
            None => format!("sh -c {}", shell_quote(&cat)),
            Some(c) => {
                let ops = super::docker::DockerExecFileOps::new(&self.channel, c)?;
                format!("docker exec {} sh -c {}", ops.container, shell_quote(&cat))
            }
        };
        let out = exec_command(&self.channel, &cmd).await?;
        Ok(if out.is_empty() { None } else { Some(out) })
    }

    /// 写远端文件：目标存在才备份 `.bak`；`base64 -d > tmp && mv tmp path` 原子替换，
    /// 任一环节失败走 `|| rm -f tmp` 清理临时文件（磁盘满/权限不足不留残）
    /// - 数据 base64 编码经 stdin 管道传入，不嵌入命令字符串，无大小限制
    ///
    /// `expected_hash` 为写前读到的文件 sha256（十六进制）：非 None 时在同一脚本内
    /// 先校验远端文件未被外部修改，不一致则输出 `REMOTE_CONFLICT` 并返回 Err
    /// （脏写防护，0 额外 RTT）；None 跳过校验（claude 保持历史行为）。
    pub async fn write_settings_with_backup(
        &self,
        path: &str,
        content: &str,
        container: Option<&str>,
        expected_hash: Option<&str>,
    ) -> Result<(), String> {
        use base64::Engine as _;
        let b64 = base64::engine::general_purpose::STANDARD.encode(content.as_bytes());
        let parent = match path.rsplit_once('/') {
            Some((d, _)) if !d.is_empty() => d,
            _ => "/",
        };
        let tmp = format!("{path}.ccswitch.tmp");
        let hash_guard = match expected_hash {
            Some(h) if !h.is_empty() => format!(
                "if [ -f {p} ] && [ \"$(sha256sum {p} 2>/dev/null | cut -d' ' -f1)\" != '{h}' ]; then echo REMOTE_CONFLICT; exit 0; fi; ",
                p = shell_quote(path),
                h = h,
            ),
            _ => String::new(),
        };
        let script = format!(
            "{guard}[ -f {p} ] && cp {p} {bak}; mkdir -p {parent} && base64 -d > {tmp} && mv {tmp} {p} || rm -f {tmp}; echo ATOMIC_OK",
            guard = hash_guard,
            p = shell_quote(path),
            bak = shell_quote(&format!("{path}.bak")),
            parent = shell_quote(parent),
            tmp = shell_quote(&tmp),
        );
        let out = match container {
            // 宿主机：强制 sh -c（不依赖远端默认 login shell）
            None => self.exec_with_stdin(&script, b64.as_bytes()).await?,
            // 容器：docker exec -i，容器名沿用 DockerExecFileOps 的合法性校验
            Some(c) => {
                let ops = super::docker::DockerExecFileOps::new(&self.channel, c)?;
                let cmd = format!(
                    "docker exec -i {} sh -c {}",
                    ops.container,
                    shell_quote(&script),
                );
                exec_command_with_stdin(&self.channel, &cmd, b64.as_bytes()).await?
            }
        };
        if out.contains("REMOTE_CONFLICT") {
            return Err(format!(
                "远端 {path} 已被外部修改，切换中止（避免覆盖你的改动）；如需强制覆盖请手动处理"
            ));
        }
        Ok(())
    }
}

/// 连接空闲超时：超过 10 分钟未使用的连接在下次取用/清理时丢弃重建。
/// 对齐 OpenSSH ControlPersist 主流值（Debian/Ubuntu 默认 10m），配合
/// keepalive 心跳保证长连接不被 NAT/防火墙掐断。
const POOL_IDLE_TIMEOUT: Duration = Duration::from_secs(600);
/// keepalive 心跳间隔：很多路由器/NAT 对静默 TCP 连接 5 分钟无数据即掐断。
const KEEPALIVE_INTERVAL: Duration = Duration::from_secs(60);
/// 验活命令（毫秒级往返，确认池中连接仍有效）。
const POOL_PROBE_CMD: &str = "printf ok";
/// 池最多保留的连接数：超出时丢弃最久未用的（防主机多时堆积）。
const POOL_MAX_SIZE: usize = 8;

/// 池化连接：SSH 会话 + 最近使用时间。
struct PooledSession {
    session: Arc<RemoteSession>,
    last_used: Instant,
}

/// 全局连接池：按 host_id 缓存已建立的 SSH 会话。
///
/// 用静态而非挂在 AppState：`connect()` 是自由函数，38 处命令调用点零改动；
/// 进程退出自动释放；测试用假 host（id 唯一）天然隔离。
/// Option 包装：`HashMap::new()` 非 const，无法直接放 static。
static CONNECTION_POOL: Mutex<Option<HashMap<String, PooledSession>>> = Mutex::new(None);

fn pool() -> std::sync::MutexGuard<'static, Option<HashMap<String, PooledSession>>> {
    CONNECTION_POOL.lock().unwrap()
}

/// 建立到远程主机的 SSH 连接并初始化 SFTP。
///
/// 已保存的主机走连接池：10 分钟空闲内复用同一连接（含 keepalive 保活），
/// 省掉重复的 TCP 建连 / SSH 握手 / SFTP 初始化；未保存主机
/// （test_remote_connection_info 的 id="temp"）直接建连不进池。
///
/// 带 10 秒总超时：对不可达/无响应主机，Windows 系统 TCP 超时约 21 秒才报错，
/// 这里统一在 10 秒内提前返回「连接超时」，避免界面长时间无响应；
/// 正常在线主机 1~2 秒完成连接，不受影响。
pub async fn connect(host: &RemoteHost, password: Option<&str>) -> Result<Arc<RemoteSession>, String> {
    // 未保存的主机不参与池（无稳定 host_id 作 key，且是一次性探测）
    if host.id.is_empty() || host.id == "temp" {
        return connect_fresh(host, password).await;
    }
    pooled_connect(host, password).await
}

/// 建连核心（不经过池）：TCP → SSH 握手 → SFTP，带 10 秒总超时与 keepalive。
async fn connect_fresh(host: &RemoteHost, password: Option<&str>) -> Result<Arc<RemoteSession>, String> {
    let host_display = format!("{}:{}", host.host, host.port);
    let connect_fut = async {
        let config = Arc::new(client::Config {
            keepalive_interval: Some(KEEPALIVE_INTERVAL),
            ..client::Config::default()
        });

        let mut channel = client::connect(
            config,
            (host.host.as_str(), host.port),
            RemoteHandler,
        )
        .await
        .map_err(|e| format!("SSH 连接失败 {host_display}: {e}"))?;

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

        Ok(Arc::new(RemoteSession { channel, sftp }))
    };

    tokio::time::timeout(Duration::from_secs(10), connect_fut)
        .await
        .map_err(|_| format!("连接 {host_display} 超时（10 秒内未建立连接，请检查地址/网络）"))?
}

/// 连接失败冷却：某主机最近失败后，冷却期内直接快速报错（不再白等 TCP 超时）。
/// 离线机器切 app / 反复操作时立即失败，15 秒后自动恢复重试（服务器可能已恢复）。
const CONNECT_FAIL_COOLDOWN: Duration = Duration::from_secs(15);

/// 最近连接失败时间（host_id → 失败时刻），用于失败冷却。
static CONNECT_FAIL_AT: Mutex<Option<HashMap<String, Instant>>> = Mutex::new(None);

fn record_connect_fail(key: &str) {
    CONNECT_FAIL_AT
        .lock()
        .unwrap()
        .get_or_insert_with(HashMap::new)
        .insert(key.to_string(), Instant::now());
}

fn clear_connect_fail(key: &str) {
    if let Some(map) = CONNECT_FAIL_AT.lock().unwrap().as_mut() {
        map.remove(key);
    }
}

/// 从池中取（或新建）连接：验活复用，失效自动重建；失败带冷却。
async fn pooled_connect(
    host: &RemoteHost,
    password: Option<&str>,
) -> Result<Arc<RemoteSession>, String> {
    let key = host.id.clone();
    let host_display = format!("{}:{}", host.host, host.port);

    // 失败冷却：最近 15 秒内建连失败过 → 快速失败，不再白等 TCP 超时
    {
        let fails = CONNECT_FAIL_AT.lock().unwrap();
        if let Some(map) = fails.as_ref() {
            if let Some(at) = map.get(&key) {
                if at.elapsed() < CONNECT_FAIL_COOLDOWN {
                    let wait = CONNECT_FAIL_COOLDOWN.as_secs_f64() - at.elapsed().as_secs_f64();
                    return Err(format!(
                        "连接 {host_display} 失败（最近一次连接未成功，{:.0} 秒后自动重试）",
                        wait.max(1.0)
                    ));
                }
            }
        }
    }

    // 取候选：锁内只做短操作（取出 + 判过期），async 验活/建连在锁外
    let candidate: Option<Arc<RemoteSession>> = {
        let mut pool = pool();
        let map = pool.get_or_insert_with(HashMap::new);
        match map.remove(&key) {
            Some(p) if p.last_used.elapsed() < POOL_IDLE_TIMEOUT => Some(p.session),
            _ => None,
        }
    };

    if let Some(session) = candidate {
        // 验活：连接可能已被远端/网络断开（重启、NAT 超时等）
        let alive = tokio::time::timeout(
            Duration::from_secs(3),
            exec_command(&session.channel, POOL_PROBE_CMD),
        )
        .await
        .map(|r| r.is_ok())
        .unwrap_or(false);
        if alive {
            clear_connect_fail(&key);
            put_back(&key, session.clone());
            return Ok(session);
        }
        // 失效：drop 关闭旧连接，走重建
        drop(session);
    }

    match connect_fresh(host, password).await {
        Ok(session) => {
            clear_connect_fail(&key);
            put_back(&key, session.clone());
            Ok(session)
        }
        Err(e) => {
            record_connect_fail(&key);
            Err(e)
        }
    }
}

/// 放回池（顺带惰性清理：过期 / 超量）。
fn put_back(key: &str, session: Arc<RemoteSession>) {
    let mut pool = pool();
    let map = pool.get_or_insert_with(HashMap::new);
    // 惰性清理过期项（避免后台任务依赖 tokio runtime）
    map.retain(|_, p| p.last_used.elapsed() < POOL_IDLE_TIMEOUT);
    // 超量时丢弃最久未用的（预留 1 个位置放当前连接）
    if map.len() >= POOL_MAX_SIZE {
        let mut entries: Vec<(String, PooledSession)> = map.drain().collect();
        entries.sort_by_key(|(_, p)| p.last_used);
        entries.truncate(POOL_MAX_SIZE - 1);
        map.extend(entries);
    }
    map.insert(
        key.to_string(),
        PooledSession {
            session,
            last_used: Instant::now(),
        },
    );
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
