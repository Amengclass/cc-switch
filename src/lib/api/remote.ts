import { invoke } from "@tauri-apps/api/core";
import type { SessionMessage, SessionMeta } from "@/types";
import type {
  EffectReport,
  RemoteConnectionInfo,
  RemoteEnvConflict,
  RemoteHost,
  RemoteSessionInfo,
} from "@/types/remote";

/**
 * 远程主机管理 API（增强版新增：SSH 远程主机统一控制面）
 */

/** 列出全部远程主机 */
export async function listRemoteHosts(): Promise<RemoteHost[]> {
  return invoke<RemoteHost[]>("list_remote_hosts");
}

/** 保存（新增/更新）远程主机；携带密码时写入系统钥匙串 */
export async function saveRemoteHost(
  host: RemoteHost,
  password?: string,
): Promise<RemoteHost> {
  return invoke<RemoteHost>("save_remote_host", { host, password });
}

/** 删除远程主机（同时清除钥匙串密码） */
export async function deleteRemoteHost(hostId: string): Promise<boolean> {
  return invoke<boolean>("delete_remote_host", { hostId });
}

/** 测试与远程主机的连接，并探测远端配置是否存在 */
export async function testRemoteConnection(
  hostId: string,
  container?: string,
): Promise<RemoteConnectionInfo> {
  return invoke<RemoteConnectionInfo>("test_remote_connection", {
    hostId,
    container: container ?? null,
  });
}

/** 读取远端 ~/.claude/settings.json（原始 JSON） */
export async function readRemoteSettings(
  hostId: string,
  container?: string,
): Promise<Record<string, unknown>> {
  return invoke<Record<string, unknown>>("read_remote_settings", {
    hostId,
    container: container ?? null,
  });
}

/** 对远程主机执行供应商切换（写入远端 settings.json env 块），返回生效报告 */
export async function switchRemoteProvider(
  hostId: string,
  providerId: string,
  container?: string,
): Promise<EffectReport> {
  return invoke<EffectReport>("switch_remote_provider", {
    hostId,
    providerId,
    container: container ?? null,
  });
}

/** 扫描远端 shell 配置中的冲突环境变量 */
export async function scanRemoteEnvConflicts(
  hostId: string,
  container?: string,
): Promise<RemoteEnvConflict[]> {
  return invoke<RemoteEnvConflict[]>("scan_remote_env_conflicts", {
    hostId,
    container: container ?? null,
  });
}

/** 清理远端 shell 配置中的冲突环境变量（注释 + .bak 备份） */
export async function cleanRemoteEnvConflicts(
  hostId: string,
  container?: string,
): Promise<{ cleaned: number; total: number }> {
  return invoke<{ cleaned: number; total: number }>(
    "clean_remote_env_conflicts",
    { hostId, container: container ?? null },
  );
}

/** 列出远端会话 jsonl 文件 */
export async function listRemoteSessions(
  hostId: string,
  container?: string,
): Promise<RemoteSessionInfo[]> {
  return invoke<RemoteSessionInfo[]>("list_remote_sessions", {
    hostId,
    container: container ?? null,
  });
}

/** 读取远端 settings.json 并匹配出当前生效的本地供应商 id */
export async function getRemoteCurrentProvider(
  hostId: string,
  container?: string,
): Promise<string | null> {
  return invoke<string | null>("get_remote_current_provider", {
    hostId,
    container: container ?? null,
  });
}

/** 检测远端是否安装 Claude Code（带超时）；true/false/null=未知 */
export async function checkRemoteClaudeInstalled(
  hostId: string,
  container?: string,
): Promise<boolean | null> {
  return invoke<boolean | null>("check_remote_claude_installed", {
    hostId,
    container: container ?? null,
  });
}

/** 检测本机是否安装 Claude Code */
export async function checkLocalClaudeInstalled(): Promise<boolean> {
  return invoke<boolean>("check_local_claude_installed");
}

/** 列出远端会话的完整元数据（复用本机 session_manager 解析逻辑） */
export async function listRemoteSessionsDetailed(
  hostId: string,
  container?: string,
): Promise<SessionMeta[]> {
  return invoke<SessionMeta[]>("list_remote_sessions_detailed", {
    hostId,
    container: container ?? null,
  });
}

/** 读取远端会话消息（复用本机解析逻辑） */
export async function getRemoteSessionMessages(
  hostId: string,
  sourcePath: string,
  container?: string,
): Promise<SessionMessage[]> {
  return invoke<SessionMessage[]>("get_remote_session_messages", {
    hostId,
    sourcePath,
    container: container ?? null,
  });
}

/** 删除远端会话 */
export async function deleteRemoteSession(
  hostId: string,
  sourcePath: string,
  sessionId: string,
  container?: string,
): Promise<boolean> {
  return invoke<boolean>("delete_remote_session", {
    hostId,
    sourcePath,
    sessionId,
    container: container ?? null,
  });
}

/** 读取远端 ~/.claude.json 的 mcpServers 映射（{id: spec}） */
export async function readRemoteMcpServers(
  hostId: string,
  container?: string,
): Promise<Record<string, unknown>> {
  return invoke<Record<string, unknown>>("read_remote_mcp_servers", {
    hostId,
    container: container ?? null,
  });
}

/** 读取远端 ~/.claude.json 的完整内容 */
export async function readRemoteMcpJson(
  hostId: string,
  container?: string,
): Promise<Record<string, unknown>> {
  return invoke<Record<string, unknown>>("read_remote_mcp_json", {
    hostId,
    container: container ?? null,
  });
}

/** 在远端 ~/.claude.json 的 mcpServers 中新增/更新一个服务器 */
export async function upsertRemoteMcpServer(
  hostId: string,
  id: string,
  spec: Record<string, unknown>,
  container?: string,
): Promise<boolean> {
  return invoke<boolean>("upsert_remote_mcp_server", {
    hostId,
    id,
    spec,
    container: container ?? null,
  });
}

/** 从远端 ~/.claude.json 的 mcpServers 中删除一个服务器 */
export async function deleteRemoteMcpServer(
  hostId: string,
  id: string,
  container?: string,
): Promise<boolean> {
  return invoke<boolean>("delete_remote_mcp_server", {
    hostId,
    id,
    container: container ?? null,
  });
}

/** 读取远端 ~/.claude/CLAUDE.md 内容（文件缺失返回空字符串） */
export async function readRemotePrompt(
  hostId: string,
  container?: string,
): Promise<string> {
  return invoke<string>("read_remote_prompt", {
    hostId,
    container: container ?? null,
  });
}

/** 将内容整文件原子写回远端 ~/.claude/CLAUDE.md */
export async function writeRemotePrompt(
  hostId: string,
  content: string,
  container?: string,
): Promise<boolean> {
  return invoke<boolean>("write_remote_prompt", {
    hostId,
    content,
    container: container ?? null,
  });
}

/** 远端 ~/.claude/skills 下的技能目录项 */
export interface RemoteSkillEntry {
  name: string;
  path: string;
  /** 从 SKILL.md frontmatter 解析的显示名（无则回退目录名） */
  displayName?: string;
  /** 从 SKILL.md frontmatter 解析的描述 */
  description?: string;
}

/** 列出远端 ~/.claude/skills/ 下的已安装技能目录 */
export async function listRemoteSkills(
  hostId: string,
  container?: string,
): Promise<RemoteSkillEntry[]> {
  return invoke<RemoteSkillEntry[]>("list_remote_skills", {
    hostId,
    container: container ?? null,
  });
}

/** 删除远端 ~/.claude/skills/ 下的一个技能目录（递归） */
export async function deleteRemoteSkill(
  hostId: string,
  name: string,
  container?: string,
): Promise<boolean> {
  return invoke<boolean>("delete_remote_skill", {
    hostId,
    name,
    container: container ?? null,
  });
}

/** 从本地 ZIP 安装技能到远端 ~/.claude/skills/，返回实际安装的技能目录名 */
export async function installRemoteSkillsFromZip(
  hostId: string,
  zipPath: string,
  container?: string,
): Promise<string[]> {
  return invoke<string[]>("install_remote_skills_from_zip", {
    hostId,
    zipPath,
    container: container ?? null,
  });
}

/** 列出远端主机上的 Docker 容器（供「目标 = 容器」选择） */
export async function listDockerContainers(
  hostId: string,
): Promise<string[]> {
  return invoke<string[]>("list_docker_containers", { hostId });
}
