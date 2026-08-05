import { invoke } from "@tauri-apps/api/core";
import type { McpServer, SessionMessage, SessionMeta } from "@/types";
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

/** 保存（新增/更新）远程主机；携带密码时写入 DPAPI 加密存储 */
export async function saveRemoteHost(
  host: RemoteHost,
  password?: string,
): Promise<RemoteHost> {
  return invoke<RemoteHost>("save_remote_host", { host, password });
}

/** 删除远程主机（同时清除加密保存的密码） */
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

/** 用未保存的连接信息直接测试 SSH（新增主机场景） */
export async function testRemoteConnectionInfo(
  host: string,
  port: number,
  username: string,
  password: string,
): Promise<RemoteConnectionInfo> {
  return invoke<RemoteConnectionInfo>("test_remote_connection_info", {
    host,
    port,
    username,
    password,
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

/** 读取远端 MCP 服务器列表（完整 McpServer，读 SSOT ~/.cc-switch/mcp.json） */
export async function readRemoteMcpServers(
  hostId: string,
  container?: string,
): Promise<McpServer[]> {
  return invoke<McpServer[]>("read_remote_mcp_servers", {
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

/** 新增/更新远端 MCP 服务器（写 SSOT + 同步 apps 启用的 live 配置） */
export async function upsertRemoteMcpServer(
  hostId: string,
  server: McpServer,
  container?: string,
): Promise<boolean> {
  return invoke<boolean>("upsert_remote_mcp_server", {
    hostId,
    server,
    container: container ?? null,
  });
}

/** 从远端删除一个 MCP 服务器（删 SSOT + 从所有 live 配置移除） */
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

/** 切换远端 MCP 服务器在指定 app 的启用状态 */
export async function toggleRemoteMcpApp(
  hostId: string,
  id: string,
  app: string,
  enabled: boolean,
  container?: string,
): Promise<boolean> {
  return invoke<boolean>("toggle_remote_mcp_app", {
    hostId,
    id,
    app,
    enabled,
    container: container ?? null,
  });
}

/** 从远端各 CLI live 配置导入 MCP 到 SSOT，返回新导入数量 */
export async function importRemoteMcpFromApps(
  hostId: string,
  container?: string,
): Promise<number> {
  return invoke<number>("import_remote_mcp_from_apps", {
    hostId,
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

/** 提示词条目（与 SQLite Prompt 结构一致） */
export interface RemotePrompt {
  id: string;
  name: string;
  content: string;
  description?: string;
  enabled: boolean;
  createdAt?: number;
  updatedAt?: number;
}

/** 列出远端 prompts.json 中的提示词列表 */
export async function listRemotePrompts(
  hostId: string,
  container?: string,
): Promise<RemotePrompt[]> {
  return invoke<RemotePrompt[]>("list_remote_prompts", {
    hostId,
    container: container ?? null,
  });
}

/** 保存远端提示词列表，并同步启用项到 CLAUDE.md */
export async function saveRemotePrompts(
  hostId: string,
  prompts: RemotePrompt[],
  container?: string,
): Promise<boolean> {
  return invoke<boolean>("save_remote_prompts", {
    hostId,
    prompts,
    container: container ?? null,
  });
}

/** 远端 ~/.cc-switch/skills 下的技能目录项 */
export interface RemoteSkillEntry {
  id: string;
  /** 显示名称（来自 SKILL.md，无则回退到目录名） */
  name: string;
  /** 技能目录名（文件系统用） */
  directory: string;
  path: string;
  /** 从 SKILL.md frontmatter 解析的描述 */
  description?: string;
  /** 各应用启用状态 */
  apps: RemoteSkillApps;
  installedAt: number;
  updatedAt: number;
  repoOwner?: string;
  repoName?: string;
  repoBranch?: string;
  readmeUrl?: string;
  contentHash?: string;
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

/** 从本地 ZIP 安装技能到远端 SSOT，返回安装的技能完整记录 */
export async function installRemoteSkillsFromZip(
  hostId: string,
  zipPath: string,
  container?: string,
): Promise<RemoteSkillRecord[]> {
  return invoke<RemoteSkillRecord[]>("install_remote_skills_from_zip", {
    hostId,
    zipPath,
    container: container ?? null,
  });
}

/** 从本地单个技能目录直接上传到远端 ~/.claude/skills/（递归） */
export async function installRemoteSkillFromDir(
  hostId: string,
  localPath: string,
  container?: string,
): Promise<string> {
  return invoke<string>("install_remote_skill_from_dir", {
    hostId,
    localPath,
    container: container ?? null,
  });
}

/** 从「发现技能」列表把一个技能安装到远端（本机下载仓库 → 上传远端 SSOT → 写 skills.json + 建链接） */
export async function installRemoteSkillFromDiscoverable(
  hostId: string,
  skill: {
    key: string;
    name: string;
    description: string;
    directory: string;
    readmeUrl?: string;
    repoOwner: string;
    repoName: string;
    repoBranch: string;
  },
  container?: string,
): Promise<RemoteSkillRecord> {
  return invoke<RemoteSkillRecord>(
    "install_remote_skill_from_discoverable",
    {
      hostId,
      skill,
      container: container ?? null,
    },
  );
}

/** 远端未管理技能条目（扫描远端文件系统） */
export interface RemoteUnmanagedSkill {
  directory: string;
  name: string;
  description?: string;
  /** 在哪些应用目录中找到 */
  foundIn: string[];
  /** 远端完整路径 */
  path: string;
}

/** 在远端文件系统上扫描未管理的技能目录 */
export async function scanRemoteUnmanagedSkills(
  hostId: string,
  container?: string,
): Promise<RemoteUnmanagedSkill[]> {
  return invoke<RemoteUnmanagedSkill[]>("scan_remote_unmanaged_skills", {
    hostId,
    container: container ?? null,
  });
}

/** skills.json 中的记录 */
export interface RemoteSkillRecord {
  id: string;
  name: string;
  description?: string;
  directory: string;
  apps: RemoteSkillApps;
  installedAt: number;
  updatedAt: number;
  repoOwner?: string;
  repoName?: string;
  repoBranch?: string;
}

export interface RemoteSkillApps {
  claude: boolean;
  codex: boolean;
  gemini: boolean;
  grokbuild: boolean;
  opencode: boolean;
  openclaw: boolean;
  hermes: boolean;
}

/** 切换远端技能在某应用的启用状态 */
export async function toggleRemoteSkillApp(
  hostId: string,
  name: string,
  app: string,
  enabled: boolean,
  container?: string,
): Promise<boolean> {
  return invoke<boolean>("toggle_remote_skill_app", {
    hostId,
    name,
    app,
    enabled,
    container: container ?? null,
  });
}

/** 在远端将技能目录复制到 SSOT → 更新 skills.json → 创建 symlink */
export async function importRemoteSkill(
  hostId: string,
  sourcePath: string,
  name: string,
  container?: string,
): Promise<RemoteSkillRecord> {
  return invoke<RemoteSkillRecord>("import_remote_skill", {
    hostId,
    sourcePath,
    name,
    container: container ?? null,
  });
}

/** 列出远端主机上的 Docker 容器（供「目标 = 容器」选择） */
export async function listDockerContainers(
  hostId: string,
): Promise<string[]> {
  return invoke<string[]>("list_docker_containers", { hostId });
}
