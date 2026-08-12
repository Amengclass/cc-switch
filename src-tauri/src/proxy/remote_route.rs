//! 远端接管路由标记（proxy 侧解析 + remote 侧写入共用）。
//!
//! 解耦目标：远端 app 经反向隧道发到本机代理的请求，必须能区分「来自哪台远端主机」，
//! 才能按**该远端自己**的当前供应商路由，而不是依赖本机当前供应商。
//!
//! 实现：远端接管写入 live 时，把 base_url 拼成 `http://<host>:<port>/ccr-<host_id>[<suffix>]`
//! （如 `http://127.0.0.1:15721/ccr-9b2a0411-.../v1/messages`）。本机代理在入口
//! （server.rs `service_fn`）剥掉 `/ccr-<host_id>` 前缀、把 host_id 放进请求 extension，
//! 各 handler 据此用 `remote_current_providers` 表里该 host 的 provider_config 路由；
//! 找不到/解析失败回退本机路由（升级前旧行为，优雅降级）。
//!
//! 不用 auth token 打标记的原因：codex 官方接管不写 bearer token（走原生登录），
//! token 标记对它失效；路径标记对所有走 HTTP 代理的 app（claude/codex/grokbuild/gemini）
//! 统一有效。
use http::Extensions;

/// 标记前缀：作为 base_url 路径的第一个段，形如 `/ccr-<host_id>/v1/messages`。
/// 取 `ccr-`（cc remote），不与任何真实 API 路径碰撞。
pub const REMOTE_ROUTE_MARKER: &str = "ccr";
const MARKER_PREFIX: &str = "/ccr-";

/// 请求扩展：标记剥离后携带的来源主机 id（由 server.rs 注入）。
#[derive(Debug, Clone)]
pub struct RemoteRoute {
    pub host_id: String,
}

/// 生成路径段：`ccr-<host_id>`。
pub fn marker_segment(host_id: &str) -> String {
    format!("{REMOTE_ROUTE_MARKER}-{host_id}")
}

/// 构造远端接管用的隧道 base_url（带主机标记）。
/// `host` 为远端隧道入口地址（宿主机=127.0.0.1；容器=网关 IP），`suffix` 为路径后缀
/// （如 `/v1`、`/grokbuild/v1`，无后缀传 ""）。
pub fn tunnel_base_url(host: &str, port: u16, host_id: &str, suffix: &str) -> String {
    format!("http://{host}:{port}/{}{suffix}", marker_segment(host_id))
}

/// 从请求 path 中剥掉 `/ccr-<host_id>` 前缀。
/// 返回 `(host_id, 剩余 path)`；非标记路径返回 None。剩余 path 以 `/` 开头
/// （路径恰为 `/ccr-<id>` 时剩余为 `/`）。
pub fn strip_marker_from_path(path: &str) -> Option<(String, String)> {
    let rest = path.strip_prefix(MARKER_PREFIX)?;
    let seg_len = rest.find('/').unwrap_or(rest.len());
    if seg_len == 0 {
        return None;
    }
    let host_id = rest[..seg_len].to_string();
    let tail = &rest[seg_len..];
    let tail = if tail.is_empty() { "/" } else { tail };
    Some((host_id, tail.to_string()))
}

/// 从请求 extensions 中读取来源主机 id（无标记返回 None）。
pub fn remote_host_from_extensions(ext: &Extensions) -> Option<String> {
    ext.get::<RemoteRoute>().map(|r| r.host_id.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_marker_with_path() {
        assert_eq!(
            strip_marker_from_path("/ccr-9b2a0411-abc/v1/messages"),
            Some(("9b2a0411-abc".to_string(), "/v1/messages".to_string()))
        );
    }

    #[test]
    fn strips_marker_bare() {
        assert_eq!(
            strip_marker_from_path("/ccr-9b2a0411-abc"),
            Some(("9b2a0411-abc".to_string(), "/".to_string()))
        );
    }

    #[test]
    fn ignores_non_marker() {
        assert_eq!(strip_marker_from_path("/v1/messages"), None);
        assert_eq!(strip_marker_from_path("/ccr-/v1/messages"), None); // 无 host_id
        assert_eq!(strip_marker_from_path("/"), None);
    }

    #[test]
    fn builds_and_parses_tunnel_url() {
        let url = tunnel_base_url("127.0.0.1", 15721, "9b2a0411-abc", "/v1");
        assert_eq!(url, "http://127.0.0.1:15721/ccr-9b2a0411-abc/v1");
        let (host_id, tail) = strip_marker_from_path("/ccr-9b2a0411-abc/v1").unwrap();
        assert_eq!(host_id, "9b2a0411-abc");
        assert_eq!(tail, "/v1");
    }

    #[test]
    fn marker_segment_ok() {
        assert_eq!(marker_segment("h1"), "ccr-h1");
    }
}
