import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { switchRemoteProvider } from "@/lib/api/remote";
import { extractErrorMessage } from "@/utils/errorUtils";

export interface SwitchRemoteProviderVars {
  hostId: string;
  providerId: string;
  container?: string;
}

/**
 * 远程切换供应商 mutation —— 与本机 `useSwitchProviderMutation` 同构：
 * - onSuccess：回写当前供应商高亮 + invalidateQueries（providers 列表）+ 集中 toast
 * - onError：统一 toast（不再散落 try/catch）
 * - 后端 `EffectReport.currentProviderId` 直接带回当前供应商 id，前端省一次
 *   `get_remote_current_provider` IPC
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
      container,
    }: SwitchRemoteProviderVars) => {
      return await switchRemoteProvider(hostId, providerId, container);
    },
    onSuccess: (report, vars) => {
      // 后端已持久化并带回当前供应商 id，直接更新高亮（不再多一次 IPC）
      onSwitched(report.currentProviderId ?? vars.providerId);
      void queryClient.invalidateQueries({ queryKey: ["providers", "claude"] });
      toast.success(
        t("remote.switchDone", {
          defaultValue: "已在 {{target}} 切换到 {{provider}}",
          target:
            report.target + (vars.container ? ` / ${vars.container}` : ""),
          provider: report.providerName,
        }),
        { description: report.notes.join("；"), closeButton: true },
      );
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
