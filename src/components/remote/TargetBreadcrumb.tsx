import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight, Container, Laptop, Loader2, Search, Server, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { RemoteHost } from "@/types/remote";

interface TargetBreadcrumbProps {
  remoteTargetId: string;
  remoteContainerId: string;
  setRemoteTargetId: (value: string) => void;
  setRemoteContainerId: (value: string) => void;
  servers: RemoteHost[];
  containers: string[];
  /** 容器列表正在加载中 */
  containersLoading?: boolean;
  /** 主机在线状态（host_id → 是否在线）；打开下拉时探活填充 */
  hostsOnline?: Record<string, boolean>;
  /** 下拉打开时触发的批量探活回调 */
  onProbeHosts?: () => void;
}

/**
 * 连体胶囊：面包屑式「目标」选择器（本机 / 服务器 / 容器）。
 *
 * 主机段 + 容器段两段一体，中间竖分隔线；点击任一段弹对应下拉。
 * - 本机：只有主机段，显示「本机」；
 * - 服务器：主机段显示服务器名，容器段默认「宿主机」，可选具体容器；
 * - 切换主机时清空容器（父级变更，子级重置回「宿主机」）。
 */
export function TargetBreadcrumb({
  remoteTargetId,
  remoteContainerId,
  setRemoteTargetId,
  setRemoteContainerId,
  servers,
  containers,
  containersLoading,
  hostsOnline,
  onProbeHosts,
}: TargetBreadcrumbProps) {
  const { t } = useTranslation();
  const [hostSearch, setHostSearch] = useState("");
  const [containerSearch, setContainerSearch] = useState("");

  const filteredHosts = hostSearch
    ? servers.filter(
        (s) =>
          s.name.toLowerCase().includes(hostSearch.toLowerCase()) ||
          s.host?.toLowerCase().includes(hostSearch.toLowerCase()),
      )
    : servers;

  const filteredContainers = containerSearch
    ? containers.filter((c) =>
        c.toLowerCase().includes(containerSearch.toLowerCase()),
      )
    : containers;

  // 下拉关闭时清空搜索
  const handleHostOpen = (open: boolean) => {
    if (!open) setHostSearch("");
  };
  const handleContainerOpen = (open: boolean) => {
    if (!open) setContainerSearch("");
  };
  const isLocal = !remoteTargetId;
  const activeHost = servers.find((s) => s.id === remoteTargetId) ?? null;
  const hostLabel = isLocal
    ? t("remote.targetLocal", { defaultValue: "本机" })
    : (activeHost?.name ?? remoteTargetId);
  const containerLabel =
    remoteContainerId || t("remote.targetHost", { defaultValue: "宿主机" });

  // 切换主机时同步清空容器（父级变更，子级重置回「宿主机」）
  // 例外：切回之前访问过的服务器时恢复上次的容器选择
  const handleSelectHost = (value: string) => {
    if (value === remoteTargetId) return;
    // 切到一台新服务器时清空容器（之前没选过容器的服务器）
    // 切回之前访问过的服务器时恢复 localStorage 里保存的容器
    const switchingToDifferentServer =
      value && remoteTargetId && value !== remoteTargetId;
    setRemoteTargetId(value);
    if (switchingToDifferentServer) {
      const saved = localStorage.getItem(`cc-switch-remote-container:${value}`) || "";
      setRemoteContainerId(saved);
    }
  };

  // 段按钮照官方分段控件（`components/ui/segmented-control.tsx`）：
  // 文字角色 text-caption、未选中 text-fg-2 / hover 到 text-fg-1，
  // 按下缩一下（active:scale-[0.96]，官方按钮族同款）。
  const segmentCls =
    "inline-flex h-full items-center gap-1.5 whitespace-nowrap rounded-[5px] px-2.5 text-caption font-medium text-fg-2 transition-[background-color,color,scale] hover:text-fg-1 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring active:scale-[0.96]";

  // 状态标识（实时，不缓存）：检测中=转圈 / 在线=绿点 / 离线=灰点
  const statusDot = (hostId: string) => {
    const online = hostsOnline?.[hostId];
    if (online === undefined) {
      return (
        <Loader2
          className="h-3 w-3 shrink-0 animate-spin text-fg-3"
          aria-label={t("remote.probing")}
        />
      );
    }
    return (
      <span
        className={cn(
          "inline-flex h-2 w-2 shrink-0 rounded-full",
          online ? "bg-success" : "bg-fg-3/40",
        )}
        aria-hidden="true"
      />
    );
  };

  return (
    // 轨道照官方分段控件：bg-subtle 底 + 3px 内衬 + h-7 / rounded-[8px]（sm 档），
    // 内圆角 = 外圆角 − 内衬 = 5px。选中段自己贴 bg-surface + shadow-v7-sm。
    <div className="inline-flex h-7 shrink-0 items-stretch rounded-[8px] bg-subtle p-[3px]">
      <DropdownMenu onOpenChange={(open) => { handleHostOpen(open); if (open) onProbeHosts?.(); }}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={cn(segmentCls, "bg-surface shadow-v7-sm")}
          >
            {isLocal ? (
              <Laptop className="h-3.5 w-3.5 shrink-0" />
            ) : (
              <Server className="h-3.5 w-3.5 shrink-0" />
            )}
            <span className="max-w-[140px] truncate">{hostLabel}</span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="min-w-[150px] max-h-[50vh] p-0 overflow-hidden [scrollbar-width:thin] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar]:block [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border"
        >
          {servers.length >= 3 && (
            <div
              className="relative border-b px-2 py-1.5"
              onKeyDown={(e) => e.stopPropagation()}
            >
              <Search className="pointer-events-none absolute left-4 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-3" />
              <Input
                value={hostSearch}
                onChange={(e) => setHostSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape" && hostSearch) {
                    e.stopPropagation();
                    setHostSearch("");
                  }
                }}
                placeholder={t("remote.searchHosts", { defaultValue: "搜索主机…" })}
                aria-label={t("remote.searchHosts", { defaultValue: "搜索主机…" })}
                className="h-7 pl-7 pr-7 text-caption"
                autoFocus
              />
              {hostSearch && (
                <button
                  type="button"
                  onClick={() => setHostSearch("")}
                  className="absolute right-3 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-control text-fg-3 transition-colors hover:bg-subtle hover:text-fg-1"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
          )}
          <DropdownMenuRadioGroup
            value={remoteTargetId}
            onValueChange={handleSelectHost}
            className="overflow-y-auto max-h-[40vh]"
          >
            <DropdownMenuRadioItem value="" className="pl-7">
              {t("remote.targetLocal", { defaultValue: "本机" })}
            </DropdownMenuRadioItem>
            {servers.length > 0 && (
              <>
                <DropdownMenuSeparator />
                {filteredHosts.map((s) => (
                  <DropdownMenuRadioItem
                    key={s.id}
                    value={s.id}
                    className="flex items-center justify-between gap-3 pl-7 pr-2"
                  >
                    <span className="truncate">{s.name}</span>
                    {statusDot(s.id)}
                  </DropdownMenuRadioItem>
                ))}
                {hostSearch && filteredHosts.length === 0 && (
                  <div className="px-3 py-2 text-center text-caption text-fg-3">
                    {t("remote.noMatchingHosts", { defaultValue: "无匹配主机" })}
                  </div>
                )}
              </>
            )}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      {!isLocal && (
        <>
          <ChevronRight
            className="h-3.5 w-3.5 shrink-0 self-center text-fg-3"
            aria-hidden="true"
          />
          <DropdownMenu onOpenChange={handleContainerOpen}>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className={cn(segmentCls, "bg-surface shadow-v7-sm")}
              >
                <Container className="h-3.5 w-3.5 shrink-0" />
                {containersLoading && !containers.length ? (
                  <Loader2 className="h-3 w-3 shrink-0 animate-spin text-fg-3" />
                ) : (
                  <span className="max-w-[140px] truncate">{containerLabel}</span>
                )}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="min-w-[180px] max-h-[50vh] p-0 overflow-hidden [scrollbar-width:thin] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar]:block [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border"
            >
              {containers.length >= 3 && (
                <div
                  className="relative border-b px-2 py-1.5"
                  onKeyDown={(e) => e.stopPropagation()}
                >
                  <Search className="pointer-events-none absolute left-4 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-3" />
                  <Input
                    value={containerSearch}
                    onChange={(e) => setContainerSearch(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape" && containerSearch) {
                        e.stopPropagation();
                        setContainerSearch("");
                      }
                    }}
                    placeholder={t("remote.searchContainers", { defaultValue: "搜索容器…" })}
                    aria-label={t("remote.searchContainers", { defaultValue: "搜索容器…" })}
                    className="h-7 pl-7 pr-7 text-caption"
                    autoFocus
                  />
                  {containerSearch && (
                    <button
                      type="button"
                      onClick={() => setContainerSearch("")}
                      className="absolute right-3 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-control text-fg-3 transition-colors hover:bg-subtle hover:text-fg-1"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  )}
                </div>
              )}
              <DropdownMenuRadioGroup
                value={remoteContainerId}
                onValueChange={setRemoteContainerId}
                className="overflow-y-auto max-h-[40vh]"
              >
                <DropdownMenuRadioItem value="" className="pl-7 pr-2">
                  <span className="flex w-full items-center justify-between gap-2">
                    {t("remote.targetHost")}
                    <span className="shrink-0 rounded-full bg-subtle px-2 py-0.5 text-badge text-fg-3">
                      {t("remote.targetHost")}
                    </span>
                  </span>
                </DropdownMenuRadioItem>
                {filteredContainers.length > 0 && (
                  <>
                    <DropdownMenuSeparator />
                    {filteredContainers.map((c) => (
                      <DropdownMenuRadioItem
                        key={c}
                        value={c}
                        className="pl-7 pr-2"
                      >
                        <span className="flex w-full items-center justify-between gap-2">
                          <span className="min-w-0 flex-1 truncate">{c}</span>
                          <span className="shrink-0 rounded-full bg-subtle px-2 py-0.5 text-badge text-fg-3">
                            {t("remote.container")}
                          </span>
                        </span>
                      </DropdownMenuRadioItem>
                    ))}
                  </>
                )}
                {containerSearch && filteredContainers.length === 0 && (
                  <div className="px-3 py-2 text-center text-caption text-fg-3">
                    {t("remote.noMatchingContainers", { defaultValue: "无匹配容器" })}
                  </div>
                )}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      )}
    </div>
  );
}
