import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { mcpApi } from "@/lib/api/mcp";
import {
  deleteRemoteMcpServer,
  importRemoteMcpFromApps,
  readRemoteMcpServers,
  toggleRemoteMcpApp,
  upsertRemoteMcpServer,
} from "@/lib/api/remote";
import type { McpServer } from "@/types";
import type { AppId } from "@/lib/api/types";
import { runSequentialBulkAction } from "@/lib/utils/sequentialBulkAction";

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

/** Toggle multiple MCP servers serially to avoid lost whole-file writes. */
export function useBulkToggleMcpApp() {
  const queryClient = useQueryClient();
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
      runSequentialBulkAction(serverIds, (serverId) =>
        mcpApi.toggleApp(serverId, app, enabled),
      ),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: ["mcp", "all"] }),
  });
}

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
    mutationFn: async (server: McpServer) => {
      if (remoteTargetId) {
        return upsertRemoteMcpServer(remoteTargetId, server, remoteContainerId);
      }
      await mcpApi.upsertUnifiedServer(server);
      return true;
    },
    // 后端可能已持久化但 live 配置写入失败，成功或失败都要刷新
    // （返回 promise 让 React Query 等 invalidate 完成，期间 mutation 保持 pending）
    onSettled: () =>
      queryClient.invalidateQueries({
        queryKey: allMcpKey(remoteTargetId, remoteContainerId),
      }),
  });
}

/**
 * 切换 MCP 服务器在特定应用的启用状态。
 * 注意：远端/容器模式只操作 ~/.claude.json（Claude 应用），其他应用不在目标写入，
 * 因此这里仅本地模式支持多应用切换；远端模式静默成功（结构一致，无副作用）。
 */
export function useToggleMcpApp(
  remoteTargetId?: string,
  remoteContainerId?: string,
) {
  const queryClient = useQueryClient();
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
        // 远端：改 SSOT apps + 同步/移除该 app 的 live 配置
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
    // 后端可能已持久化但 live 配置写入失败，成功或失败都要刷新
    // （返回 promise 让 React Query 等 invalidate 完成，期间 mutation 保持 pending）
    onSettled: () =>
      queryClient.invalidateQueries({
        queryKey: allMcpKey(remoteTargetId, remoteContainerId),
      }),
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
    // 后端可能已持久化但 live 配置写入失败，成功或失败都要刷新
    // （返回 promise 让 React Query 等 invalidate 完成，期间 mutation 保持 pending）
    onSettled: () =>
      queryClient.invalidateQueries({
        queryKey: allMcpKey(remoteTargetId, remoteContainerId),
      }),
  });
}

/**
 * 从所有应用导入 MCP 服务器。
 * 远端/容器模式无本地 DB，不支持导入，直接返回 0。
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
