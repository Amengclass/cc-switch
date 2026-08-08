import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { getRemoteProviders, switchRemoteProvider } from "@/lib/api/remote";
import type { RemoteProvidersView } from "@/lib/api/remote";
import { extractErrorMessage } from "@/utils/errorUtils";

export interface SwitchRemoteProviderVars {
  hostId: string;
  providerId: string;
  app: string;
  container?: string;
}

/**
 * 远端供应商面板数据源 query（per-target 独立）：
 * 目标选择器指向哪，列表就显示哪台机器的供应商（该目标自己的 SSOT）。
 * 本机目标（remoteTargetId 为空）不启用，走本机 useProvidersQuery。
 */
export const useRemoteProvidersQuery = (
  hostId?: string,
  container?: string,
  app?: string,
  autoImportDefault?: boolean,
  /** 目标选择器已探明该主机离线：跳过连接请求，直接用离线状态（不再尝试建连） */
  knownOffline?: boolean,
) => {
  return useQuery({
    queryKey: ["remoteProviders", hostId, container || "__host__", app],
    queryFn: () =>
      getRemoteProviders(hostId!, app!, container, autoImportDefault ?? true),
    enabled: Boolean(hostId && app && !knownOffline),
  });
};

/**
 * 远程切换供应商 mutation —— 与本机 `useSwitchProviderMutation` 同构：
 * - onSuccess：回写当前供应商高亮 + invalidateQueries（providers 列表）+ 集中 toast
 * - onError：统一 toast（不再散落 try/catch）
 * - 后端 `EffectReport.currentProviderId` 直接带回当前供应商 id，前端省一次
 *   `get_remote_current_provider` IPC
 * - `app` 参数化：claude / codex 等，invalidate 对应 app 的 providers 缓存
 */
export const useSwitchRemoteProviderMutation = (
  onSwitched: (providerId: string | null) => void,
) => {
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  return useMutation({
    mutationFn: async ({
      hostId,
      providerId,
      app,
      container,
    }: SwitchRemoteProviderVars) => {
      return await switchRemoteProvider(hostId, providerId, app, container);
    },
    onSuccess: (report, vars) => {
      // 后端已持久化并带回当前供应商 id，直接更新高亮（不再多一次 IPC）
      onSwitched(report.currentProviderId ?? vars.providerId);
      void queryClient.invalidateQueries({
        queryKey: ["providers", vars.app],
      });
      // per-target 独立：切换会写 live（additive 的「添加」= 切换，把供应商写入 live
      // 并启用），因此要同时更新 currentProviderId 与 liveIds（按钮态「添加」→「移除」
      // 立即翻转）。直接用服务端返回的 current 更新缓存，免第二次 SSH refetch。
      queryClient.setQueryData<RemoteProvidersView | undefined>(
        ["remoteProviders", vars.hostId, vars.container || "__host__", vars.app],
        (old) => {
          if (!old) return old;
          const isAdditive =
            vars.app === "opencode" ||
            vars.app === "openclaw" ||
            vars.app === "hermes";
          const liveIds =
            isAdditive && !old.liveIds.includes(vars.providerId)
              ? [...old.liveIds, vars.providerId]
              : old.liveIds;
          return {
            ...old,
            currentProviderId: report.currentProviderId ?? vars.providerId,
            liveIds,
          };
        },
      );
      // 成功提示对齐本机 useProviderActions.ts 的按 app 文案，并强调「远端」：
      // codex / grokbuild 的 live 配置无热重载，需重启远端客户端才生效。
      const target =
        report.target + (vars.container ? ` / ${vars.container}` : "");
      const provider = report.providerName;
      let switchMessage = t("remote.switchDone", {
        defaultValue: "已在远端 {{target}} 切换到 {{provider}}",
        target,
        provider,
      });
      if (vars.app === "codex") {
        switchMessage = t("remote.switchDoneCodex", {
          defaultValue:
            "已在远端 {{target}} 切换到 {{provider}}，请重启远端 Codex 客户端以生效",
          target,
          provider,
        });
      } else if (vars.app === "grokbuild") {
        switchMessage = t("remote.switchDoneGrok", {
          defaultValue:
            "已在远端 {{target}} 切换到 {{provider}}，请重启远端 Grok Build 以生效",
          target,
          provider,
        });
      }
      toast.success(switchMessage, { closeButton: true });
    },
    onError: (error: Error) => {
      const detail = extractErrorMessage(error) || t("common.unknown");
      toast.error(t("remote.switchError", { defaultValue: "远程切换失败" }), {
        description: detail,
        closeButton: true,
      });
    },
  });
};
