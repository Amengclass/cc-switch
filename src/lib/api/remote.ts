import { invoke } from "@tauri-apps/api/core";
import type { McpServer, Provider, SessionMessage, SessionMeta } from "@/types";
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

/** 批量探测主机在线状态（目标选择器打开时调用；在线=绿点，离线=灰点） */
export async function probeHostsOnline(
  hostIds: string[],
): Promise<Record<string, boolean>> {
  return invoke<Record<string, boolean>>("probe_hosts_online", { hostIds });
}

/** 设置远端 OpenClaw 默认模型（对齐本机 setDefaultModel：{primary, fallbacks}） */
export async function setRemoteOpenClawDefaultModel(
  hostId: string,
  container: string | undefined,
  defaultModel: { primary: string; fallbacks: string[] },
): Promise<void> {
  return invoke("set_remote_openclaw_default_model", {
    hostId,
    container: container ?? null,
    defaultModel,
  });
}

/** 测试与远程主机的连接：探测当前 app 的主配置是否存在 + 该 app 的 CLI 是否安装 */
export async function testRemoteConnection(
  hostId: string,
  app: string,
  container?: string,
): Promise<RemoteConnectionInfo> {
  return invoke<RemoteConnectionInfo>("test_remote_connection", {
    hostId,
    container: container ?? null,
    app,
  });
}

/** 用未保存的连接信息直接测试 SSH（新增主机场景） */
export async function testRemoteConnectionInfo(
  host: string,
  port: number,
  username: string,
  password: string,
  app: string,
): Promise<RemoteConnectionInfo> {
  return invoke<RemoteConnectionInfo>("test_remote_connection_info", {
    host,
    port,
    username,
    password,
    app,
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

/** 对远程主机执行供应商切换（写入远端对应 app 的 live 文件），返回生效报告 */
export async function switchRemoteProvider(
  hostId: string,
  providerId: string,
  app: string,
  container?: string,
): Promise<EffectReport> {
  return invoke<EffectReport>("switch_remote_provider", {
    hostId,
    providerId,
    app,
    container: container ?? null,
  });
}

/**
 * 重新应用远端目标「当前生效供应商」到 live（对齐本机「开关即生效」语义）。
 * 「走本机路由」开关开启/关闭时调用，立即按新意图重写 live，无需再手动切一次。
 */
export async function reapplyRemoteProvider(
  hostId: string,
  app: string,
  container?: string,
): Promise<EffectReport> {
  return invoke<EffectReport>("reapply_remote_provider", {
    hostId,
    app,
    container: container ?? null,
  });
}

/** 远程目标下测试 Provider 连通性（经 SSH 在远端 curl base_url，真实反映远端网络） */
export async function testRemoteProviderConnection(
  hostId: string,
  providerId: string,
  app: string,
  container?: string,
): Promise<RemoteProviderTestResult> {
  return invoke<RemoteProviderTestResult>("test_remote_provider_connection", {
    hostId,
    providerId,
    app,
    container: container ?? null,
  });
}

/** 远程 Provider 连通性测试结果 */
export interface RemoteProviderTestResult {
  baseUrl: string;
  httpCode: string;
  reachable: boolean;
}

/** 远端供应商面板数据源（per-target 独立：读该目标机器自己的 SSOT） */
export interface RemoteProvidersView {
  providers: Record<string, Provider>;
  /** 非 additive：当前生效供应商；additive 为 null */
  currentProviderId: string | null;
  /** additive：远端 live 中的供应商 ID 集合（isInConfig 按钮态） */
  liveIds: string[];
}

/** 后端原始视图（snake_case）→ 前端 camelCase 视图 */
function toRemoteProvidersView(view: {
  providers: Provider[];
  current_provider_id: string | null;
  live_ids: string[];
}): RemoteProvidersView {
  const providers: Record<string, Provider> = {};
  for (const p of view.providers) {
    providers[p.id] = p;
  }
  return {
    providers,
    currentProviderId: view.current_provider_id,
    liveIds: view.live_ids,
  };
}

/** 读远端目标的供应商列表（首次自动从该远端 live 导入，对齐本机启动导入语义；
 *  autoImportDefault 控制非 additive 是否每次刷新 default 卡——设置项，默认开） */
export async function getRemoteProviders(
  hostId: string,
  app: string,
  container?: string,
  autoImportDefault?: boolean,
): Promise<RemoteProvidersView> {
  const view = await invoke<{
    providers: Provider[];
    current_provider_id: string | null;
    live_ids: string[];
  }>("get_remote_providers", {
    hostId,
    app,
    container: container ?? null,
    autoImportDefault: autoImportDefault ?? null,
  });
  return toRemoteProvidersView(view);
}

/** 在远端目标添加供应商（写入该目标 SSOT；addToLive=true 时同时写入 live）。
 *  返回最新视图，调用方 setQueryData 直接刷新（免第二次 SSH 往返）。 */
export async function addRemoteProvider(
  hostId: string,
  app: string,
  provider: Provider,
  addToLive?: boolean,
  container?: string,
): Promise<RemoteProvidersView> {
  const view = await invoke<{
    providers: Provider[];
    current_provider_id: string | null;
    live_ids: string[];
  }>("add_remote_provider", {
    hostId,
    app,
    provider,
    addToLive: addToLive ?? null,
    container: container ?? null,
  });
  return toRemoteProvidersView(view);
}

/** 编辑远端目标的供应商（更新 SSOT；在生效位置时重写远端 live）。
 *  返回最新视图，调用方 setQueryData 直接刷新。 */
export async function updateRemoteProvider(
  hostId: string,
  app: string,
  provider: Provider,
  originalId?: string,
  container?: string,
): Promise<RemoteProvidersView> {
  const view = await invoke<{
    providers: Provider[];
    current_provider_id: string | null;
    live_ids: string[];
  }>("update_remote_provider", {
    hostId,
    app,
    provider,
    originalId: originalId ?? null,
    container: container ?? null,
  });
  return toRemoteProvidersView(view);
}

/** 删除远端目标的供应商（SSOT 移除；additive 且已写入 live 时同时移除 live）。
 *  返回最新视图，调用方 setQueryData 直接刷新。 */
export async function deleteRemoteProvider(
  hostId: string,
  app: string,
  providerId: string,
  container?: string,
): Promise<RemoteProvidersView> {
  const view = await invoke<{
    providers: Provider[];
    current_provider_id: string | null;
    live_ids: string[];
  }>("delete_remote_provider", {
    hostId,
    app,
    providerId,
    container: container ?? null,
  });
  return toRemoteProvidersView(view);
}

/** 从远端 live 配置移除某供应商（对齐本机 remove_from_live_config：仅 additive app 支持）。
 *  返回最新视图，调用方 setQueryData 直接刷新。 */
export async function removeRemoteProviderFromLive(
  hostId: string,
  app: string,
  providerId: string,
  container?: string,
): Promise<RemoteProvidersView> {
  const view = await invoke<{
    providers: Provider[];
    current_provider_id: string | null;
    live_ids: string[];
  }>("remove_remote_provider_from_live", {
    hostId,
    app,
    providerId,
    container: container ?? null,
  });
  return toRemoteProvidersView(view);
}

/** 删除供应商后清理远端「当前供应商」记录（live 文件不动，对齐本机 delete 语义） */
export async function clearRemoteProviderRecord(
  hostId: string,
  app: string,
): Promise<void> {
  return invoke("clear_remote_provider_record", { hostId, app });
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

/** 读取远端 settings.json 并匹配出当前生效的本地供应商 id（per-app） */
export async function getRemoteCurrentProvider(
  hostId: string,
  app: string,
  container?: string,
): Promise<string | null> {
  return invoke<string | null>("get_remote_current_provider", {
    hostId,
    app,
    container: container ?? null,
  });
}

/** 检测远端是否安装指定 app 的 CLI（带超时）；true/false/null=未知 */
export async function checkRemoteCliInstalled(
  hostId: string,
  app: string,
  container?: string,
): Promise<boolean | null> {
  return invoke<boolean | null>("check_remote_cli_installed", {
    hostId,
    app,
    container: container ?? null,
  });
}

/** 检测本机是否安装指定 app 的 CLI */
export async function checkLocalCliInstalled(app: string): Promise<boolean> {
  return invoke<boolean>("check_local_cli_installed", { app });
}

/** 列出远端会话的完整元数据（复用本机 session_manager 解析逻辑） */
export async function listRemoteSessionsDetailed(
  hostId: string,
  container?: string,
  app?: string,
): Promise<SessionMeta[]> {
  return invoke<SessionMeta[]>("list_remote_sessions_detailed", {
    hostId,
    container: container ?? null,
    app: app ?? "claude",
  });
}

/** 读取远端会话消息（复用本机解析逻辑） */
export async function getRemoteSessionMessages(
  hostId: string,
  sourcePath: string,
  sessionId: string,
  container?: string,
  app?: string,
): Promise<SessionMessage[]> {
  return invoke<SessionMessage[]>("get_remote_session_messages", {
    hostId,
    sourcePath,
    sessionId,
    container: container ?? null,
    app: app ?? "claude",
  });
}

/** 删除远端会话 */
export async function deleteRemoteSession(
  hostId: string,
  sourcePath: string,
  sessionId: string,
  container?: string,
  app?: string,
): Promise<boolean> {
  return invoke<boolean>("delete_remote_session", {
    hostId,
    sourcePath,
    sessionId,
    container: container ?? null,
    app: app ?? "claude",
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

/** 批量开关返回结构，与本地 runSequentialBulkAction 形状一致。 */
export interface RemoteBulkToggleResult {
  succeeded: string[];
  failed: Array<{ item: string; error: string }>;
}

/** 一次连接内批量切换多个 MCP 服务器在某应用的启用状态 */
export async function bulkToggleRemoteMcpApp(
  hostId: string,
  ids: string[],
  app: string,
  enabled: boolean,
  container?: string,
): Promise<RemoteBulkToggleResult> {
  return invoke<RemoteBulkToggleResult>("bulk_toggle_remote_mcp_app", {
    hostId,
    ids,
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

/** 读取远端 live 提示词文件内容（文件缺失返回空字符串；app 缺省 claude 兼容） */
export async function readRemotePrompt(
  hostId: string,
  container?: string,
  app?: string,
): Promise<string> {
  return invoke<string>("read_remote_prompt", {
    hostId,
    container: container ?? null,
    app: app ?? "claude",
  });
}

/** 将内容整文件原子写回远端 live 提示词文件 */
export async function writeRemotePrompt(
  hostId: string,
  content: string,
  container?: string,
  app?: string,
): Promise<boolean> {
  return invoke<boolean>("write_remote_prompt", {
    hostId,
    content,
    container: container ?? null,
    app: app ?? "claude",
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
  app?: string,
): Promise<RemotePrompt[]> {
  return invoke<RemotePrompt[]>("list_remote_prompts", {
    hostId,
    container: container ?? null,
    app: app ?? "claude",
  });
}

/** 保存远端提示词列表，并同步启用项到 live 提示词文件 */
export async function saveRemotePrompts(
  hostId: string,
  prompts: RemotePrompt[],
  container?: string,
  app?: string,
): Promise<boolean> {
  return invoke<boolean>("save_remote_prompts", {
    hostId,
    prompts,
    container: container ?? null,
    app: app ?? "claude",
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
  app?: string,
): Promise<RemoteSkillRecord[]> {
  return invoke<RemoteSkillRecord[]>("install_remote_skills_from_zip", {
    hostId,
    zipPath,
    container: container ?? null,
    app: app ?? "claude",
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
  app?: string,
): Promise<RemoteSkillRecord> {
  return invoke<RemoteSkillRecord>("install_remote_skill_from_discoverable", {
    hostId,
    skill,
    container: container ?? null,
    app: app ?? "claude",
  });
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

/** 一次连接内批量切换多个远端技能在某应用的启用状态 */
export async function bulkToggleRemoteSkillApp(
  hostId: string,
  ids: string[],
  app: string,
  enabled: boolean,
  container?: string,
): Promise<RemoteBulkToggleResult> {
  return invoke<RemoteBulkToggleResult>("bulk_toggle_remote_skill_app", {
    hostId,
    ids,
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
  app?: string,
): Promise<RemoteSkillRecord> {
  return invoke<RemoteSkillRecord>("import_remote_skill", {
    hostId,
    sourcePath,
    name,
    container: container ?? null,
    app: app ?? "claude",
  });
}

/** 列出远端主机上的 Docker 容器（供「目标 = 容器」选择） */
export async function listDockerContainers(hostId: string): Promise<string[]> {
  return invoke<string[]>("list_docker_containers", { hostId });
}
