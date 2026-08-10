import { Loader2, Radio } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { Switch } from "@/components/ui/switch";
import { useProxyStatus } from "@/hooks/useProxyStatus";
import { reapplyRemoteProvider, saveRemoteHost } from "@/lib/api/remote";
import { cn } from "@/lib/utils";
import type { RemoteHost } from "@/types/remote";

interface RemoteRouteToggleProps {
  /** 宿主机目标：传入该主机则显示「走本机路由」开关（读/写 routeThroughLocalProxy） */
  host?: RemoteHost;
  /** 容器目标：显示所属宿主机的开关（隧道建在宿主机上），文案按容器场景 */
  container?: boolean;
  /** 当前应用（用于按 app 显示专属文案，与 ProxyToggle/ClaudeDesktopRouteToggle 统一） */
  activeApp?: string;
  /** 调用远端 API 用的 app 参数（claude-desktop 映射为 claude 的 sharedFeatureApp 值） */
  appForApi?: string;
  /** 容器 id（容器目标时传给远端命令做网络探测/DNAT 下发） */
  containerId?: string;
  /** 保存成功后的回调（用于更新上层 hosts 列表状态） */
  onUpdated?: (host: RemoteHost) => void;
  className?: string;
}

/**
 * 顶栏「走本机路由」开关（按目标动态渲染）：
 * - 宿主机目标：显示该主机的 routeThroughLocalProxy 开关，切换直接写主机设置；
 * - 容器目标：隧道建在宿主机 SSH 上，故显示所属宿主机的同一开关（文案按容器场景）；
 *   容器网络自动探测（host→localhost / bridge→网关+DNAT）由后端切换时完成。
 */
export function RemoteRouteToggle({
  host,
  container,
  activeApp,
  appForApi,
  containerId,
  onUpdated,
  className,
}: RemoteRouteToggleProps) {
  const { t } = useTranslation();
  const [saving, setSaving] = useState(false);
  // 本机路由未运行时，远端走本机路由失去能力基础 → 禁用（不动 DB）
  const { isRunning: localRouteRunning } = useProxyStatus();
  const routeDisabled = !localRouteRunning;

  // 与 ProxyToggle 相同的 app 显示名映射，保证文案统一
  const appLabel =
    activeApp === "claude-desktop"
      ? "Claude Desktop"
      : activeApp === "claude"
        ? "Claude"
        : activeApp === "codex"
          ? "Codex"
          : activeApp === "gemini"
            ? "Gemini"
            : "Grok Build";

  // 未找到所属主机（异常态）：不渲染
  if (!host) {
    return null;
  }

  const handleToggle = async (checked: boolean) => {
    if (saving) return;
    setSaving(true);
    try {
      const updated = await saveRemoteHost({
        ...host,
        routeThroughLocalProxy: checked,
      });
      onUpdated?.(updated);
      // 对齐本机「开关即生效」：立即把当前供应商按新意图重写 live，
      // 无需用户再手动切一次供应商（含容器网络探测/DNAT 下发）。
      if (appForApi) {
        try {
          await reapplyRemoteProvider(host.id, appForApi, containerId);
        } catch (error) {
          console.error("[RemoteRouteToggle] reapply failed:", error);
          toast.error(
            t("remote.route.reapplyFailed", {
              defaultValue: "开关已保存，但重新应用当前供应商到远端失败，请再切一次供应商",
            }),
          );
        }
      }
      toast.success(
        checked
          ? t("remote.route.enabled", {
              defaultValue: `已开启「${host.name}」走本机路由`,
            })
          : t("remote.route.disabled", {
              defaultValue: `已关闭「${host.name}」走本机路由`,
            }),
      );
    } catch (error) {
      console.error("[RemoteRouteToggle] toggle failed:", error);
      toast.error(
        t("remote.route.toggleFailed", {
          defaultValue: "切换走本机路由失败，请重试",
        }),
      );
    } finally {
      setSaving(false);
    }
  };

  const tooltipText = routeDisabled
    ? t("remote.route.tooltip.localRouteOff", {
        name: host.name,
        appLabel,
        defaultValue: `需先开启本机路由，「${host.name}」的 ${appLabel} 才能走本机路由`,
      })
    : host.routeThroughLocalProxy
      ? container
        ? t("remote.route.tooltip.containerActive", {
            name: host.name,
            appLabel,
            defaultValue: `容器内 ${appLabel} 经「${host.name}」宿主机隧道走本机路由（需本机路由已开启）`,
          })
        : t("remote.route.tooltip.active", {
            name: host.name,
            appLabel,
            defaultValue: `「${host.name}」的 ${appLabel} 已走本机路由（需本机路由已开启）`,
          })
      : container
        ? t("remote.route.tooltip.containerInactive", {
            name: host.name,
            appLabel,
            defaultValue: `开启后，容器内 ${appLabel} 经「${host.name}」宿主机隧道走本机路由（需本机路由已开启）`,
          })
        : t("remote.route.tooltip.inactive", {
            name: host.name,
            appLabel,
            defaultValue: `开启后「${host.name}」的 ${appLabel} 走本机路由（需本机路由已开启）`,
          });

  return (
    <div
      className={cn(
        "flex items-center gap-1 px-1.5 h-8 rounded-lg bg-muted/50 transition-all",
        routeDisabled && "opacity-60",
        className,
      )}
      title={tooltipText}
    >
      {saving ? (
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      ) : (
        <Radio
          className={cn(
            "h-4 w-4 transition-colors",
            host.routeThroughLocalProxy && !routeDisabled
              ? "text-emerald-500 status-heartbeat"
              : "text-muted-foreground",
          )}
        />
      )}
      <Switch
        checked={host.routeThroughLocalProxy}
        onCheckedChange={handleToggle}
        disabled={saving || routeDisabled}
      />
    </div>
  );
}
