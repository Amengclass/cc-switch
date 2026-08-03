import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { mcpApi } from "@/lib/api/mcp";
import {
  deleteRemoteMcpServer,
  readRemoteMcpServers,
  upsertRemoteMcpServer,
} from "@/lib/api/remote";
import type { McpServer } from "@/types";
import type { AppId } from "@/lib/api/types";

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
    queryFn: () =>
      remoteTargetId
        ? readRemoteMcpServers(remoteTargetId, remoteContainerId)
        : mcpApi.getAllServers(),
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
        return upsertRemoteMcpServer(
          remoteTargetId,
          server.id,
          server.server,
          remoteContainerId,
        );
      }
      await mcpApi.upsertUnifiedServer(server);
      return true;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: allMcpKey(remoteTargetId, remoteContainerId),
      });
    },
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
      // 远端 ~/.claude.json 的 mcpServers 不含 per-app 启用标记，仅 Claude 生效。
      if (remoteTargetId) {
        if (app !== "claude") {
          // 远端只管理 Claude Code 的 MCP；切换其他应用无对应目标，忽略。
          return true;
        }
        const spec = (queryClient.getQueryData<
          Record<string, Record<string, unknown>>
        >(allMcpKey(remoteTargetId, remoteContainerId)) ?? {})[serverId];
        if (!spec) {
          return Promise.reject(new Error("目标未找到该 MCP 服务器"));
        }
        // enabled=true 时确保服务器存在；enabled=false 时删除。
        return enabled
          ? upsertRemoteMcpServer(
              remoteTargetId,
              serverId,
              spec,
              remoteContainerId,
            )
          : deleteRemoteMcpServer(remoteTargetId, serverId, remoteContainerId);
      }
      await mcpApi.toggleApp(serverId, app, enabled);
      return true;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: allMcpKey(remoteTargetId, remoteContainerId),
      });
    },
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
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: allMcpKey(remoteTargetId, remoteContainerId),
      });
    },
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
        return Promise.resolve(0);
      }
      return mcpApi.importFromApps();
    },
    // 后端是 best-effort 导入：部分应用失败会返回错误，但其余应用的
    // 服务器已经入库，失败时也要刷新列表。
    onSettled: () => {
      queryClient.invalidateQueries({
        queryKey: allMcpKey(remoteTargetId, remoteContainerId),
      });
    },
  });
}
