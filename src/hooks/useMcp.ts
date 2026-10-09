import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { mcpApi } from "@/lib/api/mcp";
import {
  bulkToggleRemoteMcpApp,
  deleteRemoteMcpServer,
  importRemoteMcpFromApps,
  readRemoteMcpServers,
  toggleRemoteMcpApp,
  upsertRemoteMcpServer,
} from "@/lib/api/remote";
import type { McpServer, McpServersMap } from "@/types";
import type { AppId } from "@/lib/api/types";
import { runSequentialBulkAction } from "@/lib/utils/sequentialBulkAction";

// 本补丁层：远端目标（SSH 主机 / Docker 容器）下，MCP 数据源切到该目标自己的
// SSOT（~/.claude.json 的 mcpServers）。query key 带 remoteTargetId，
// 各目标各自缓存、互不串台。v3.20.4 的 remote-aware 逻辑在 v4.0.4 重基时丢失，
// 这里按 v4.0.4 的 hooks 结构（含乐观更新）重新适配。
const allMcpKey = (remoteTargetId?: string, remoteContainerId?: string) =>
  remoteTargetId
    ? ["mcp", "remote", remoteTargetId, remoteContainerId ?? "__host__"]
    : ["mcp", "all"];

/**
 * 查询所有 MCP 服务器（统一管理）。
 * 选中远端/容器目标时，直接读取该目标 ~/.claude.json 的 mcpServers。
 */
export function useAllMcpServers(
  remoteTargetId?: string,
  remoteContainerId?: string,
) {
  return useQuery({
    queryKey: allMcpKey(remoteTargetId, remoteContainerId),
    queryFn: async () => {
      if (!remoteTargetId) {
        return mcpApi.getAllServers();
      }
      // 远端返回完整 McpServer 数组 → 转 map（id -> McpServer）
      const list = await readRemoteMcpServers(
        remoteTargetId,
        remoteContainerId,
      );
      const map: Record<string, McpServer> = {};
      for (const server of list) {
        map[server.id] = server;
      }
      return map;
    },
  });
}

/** 编辑页保存用的 mutation key：页面据此在保存进行中锁住导航 */
export const MCP_UPSERT_MUTATION_KEY = ["mcp", "upsert"] as const;

/**
 * 添加或更新 MCP 服务器。
 * 选中远端/容器目标时，直接写该目标 ~/.claude.json 的 mcpServers。
 */
export function useUpsertMcpServer(
  remoteTargetId?: string,
  remoteContainerId?: string,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: MCP_UPSERT_MUTATION_KEY,
    mutationFn: async (server: McpServer) => {
      if (remoteTargetId) {
        return upsertRemoteMcpServer(remoteTargetId, server, remoteContainerId);
      }
      await mcpApi.upsertUnifiedServer(server);
      return true;
    },
    // The database is updated before live configs are synchronized, so an
    // error can still leave a persisted change that the list must reflect.
    onSettled: () =>
      queryClient.invalidateQueries({
        queryKey: allMcpKey(remoteTargetId, remoteContainerId),
      }),
  });
}

/** Toggle multiple MCP servers serially to avoid lost whole-file writes. */
export function useBulkToggleMcpApp(
  remoteTargetId?: string,
  remoteContainerId?: string,
) {
  const queryClient = useQueryClient();
  const queryKey = allMcpKey(remoteTargetId, remoteContainerId);
  return useMutation({
    mutationFn: ({
      serverIds,
      app,
      enabled,
    }: {
      serverIds: string[];
      app: AppId;
      enabled: boolean;
    }) =>
      remoteTargetId
        ? bulkToggleRemoteMcpApp(
            remoteTargetId,
            serverIds,
            app,
            enabled,
            remoteContainerId,
          )
        : runSequentialBulkAction(serverIds, (serverId) =>
            mcpApi.toggleApp(serverId, app, enabled),
          ),
    onSettled: () => queryClient.invalidateQueries({ queryKey }),
  });
}

/**
 * 切换 MCP 服务器在特定应用的启用状态。
 * 选中远端/容器目标时，改该目标 SSOT apps + 同步/移除该 app 的 live 配置。
 */
export function useToggleMcpApp(
  remoteTargetId?: string,
  remoteContainerId?: string,
) {
  const queryClient = useQueryClient();
  const queryKey = allMcpKey(remoteTargetId, remoteContainerId);
  return useMutation({
    mutationFn: async ({
      serverId,
      app,
      enabled,
    }: {
      serverId: string;
      app: AppId;
      enabled: boolean;
    }) => {
      if (remoteTargetId) {
        return toggleRemoteMcpApp(
          remoteTargetId,
          serverId,
          app,
          enabled,
          remoteContainerId,
        );
      }
      await mcpApi.toggleApp(serverId, app, enabled);
      return true;
    },
    // 乐观更新：点了格子立刻翻过来，不等写完再刷新；失败时回滚
    onMutate: async ({ serverId, app, enabled }) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<McpServersMap>(queryKey);
      const server = previous?.[serverId];
      if (previous && server) {
        queryClient.setQueryData<McpServersMap>(queryKey, {
          ...previous,
          [serverId]: { ...server, apps: { ...server.apps, [app]: enabled } },
        });
      }
      return { previous };
    },
    onError: (_error, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(queryKey, context.previous);
      }
    },
    // The backend may update the database before a live-config write fails.
    // Always refresh so the UI reflects the persisted state after an error.
    onSettled: () => queryClient.invalidateQueries({ queryKey }),
  });
}

/**
 * 删除 MCP 服务器。
 * 选中远端/容器目标时，从该目标 ~/.claude.json 的 mcpServers 删除。
 */
export function useDeleteMcpServer(
  remoteTargetId?: string,
  remoteContainerId?: string,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      remoteTargetId
        ? deleteRemoteMcpServer(remoteTargetId, id, remoteContainerId)
        : mcpApi.deleteUnifiedServer(id),
    // Deletion reaches the database before live-config cleanup, so refresh
    // after both success and failure to avoid operating on a removed entry.
    onSettled: () =>
      queryClient.invalidateQueries({
        queryKey: allMcpKey(remoteTargetId, remoteContainerId),
      }),
  });
}

/**
 * 按这里的开关把 MCP 重新写进各应用的配置（不传 apps＝全部受管应用），逐应用返回结果
 * 远端/容器模式无本地 DB，不支持重同步。
 */
export function useResyncMcpToApps() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (apps?: AppId[]) => mcpApi.resyncToApps(apps),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: ["mcp", "all"] }),
  });
}

/**
 * 从所有应用导入 MCP 服务器。
 * 远端/容器模式：从该远端各 CLI live 配置导入到该远端 SSOT。
 */
export function useImportMcpFromApps(
  remoteTargetId?: string,
  remoteContainerId?: string,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => {
      if (remoteTargetId) {
        return importRemoteMcpFromApps(remoteTargetId, remoteContainerId);
      }
      return mcpApi.importFromApps();
    },
    // 后端是 best-effort 导入：部分应用失败会返回错误，但其余应用的
    // 服务器已经入库，失败时也要刷新列表。
    onSettled: () =>
      queryClient.invalidateQueries({
        queryKey: allMcpKey(remoteTargetId, remoteContainerId),
      }),
  });
}