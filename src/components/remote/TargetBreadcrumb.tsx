import { useTranslation } from "react-i18next";
import { ChevronRight, Container, Laptop, Server } from "lucide-react";
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
}: TargetBreadcrumbProps) {
  const { t } = useTranslation();
  const isLocal = !remoteTargetId;
  const activeHost = servers.find((s) => s.id === remoteTargetId) ?? null;
  const hostLabel = isLocal
    ? t("remote.targetLocal", { defaultValue: "本机" })
    : (activeHost?.name ?? remoteTargetId);
  const containerLabel =
    remoteContainerId || t("remote.targetHost", { defaultValue: "宿主机" });

  // 切换主机时同步清空容器（父级变更，子级重置回「宿主机」）
  const handleSelectHost = (value: string) => {
    if (value === remoteTargetId) return;
    setRemoteTargetId(value);
    setRemoteContainerId("");
  };

  const segmentCls =
    "inline-flex h-full items-center gap-1.5 px-2.5 text-muted-foreground hover:bg-black/5 dark:hover:bg-white/5 hover:text-foreground transition-colors focus-visible:outline-none";

  return (
    <div className="inline-flex h-8 shrink-0 items-center overflow-hidden rounded-lg border border-border/80 bg-muted text-xs shadow-sm">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" className={cn(segmentCls, "rounded-l-lg")}>
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
          className="min-w-[180px] max-h-[50vh] overflow-y-auto [scrollbar-width:thin] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar]:block [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border"
        >
          <DropdownMenuRadioGroup
            value={remoteTargetId}
            onValueChange={handleSelectHost}
          >
            <DropdownMenuRadioItem value="">
              {t("remote.targetLocal", { defaultValue: "本机" })}
            </DropdownMenuRadioItem>
            {servers.length > 0 && (
              <>
                <DropdownMenuSeparator />
                {servers.map((s) => (
                  <DropdownMenuRadioItem key={s.id} value={s.id}>
                    {s.name}
                  </DropdownMenuRadioItem>
                ))}
              </>
            )}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      {!isLocal && (
        <>
          <ChevronRight
            className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60"
            aria-hidden="true"
          />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" className={cn(segmentCls, "rounded-r-lg")}>
                <Container className="h-3.5 w-3.5 shrink-0" />
                <span className="max-w-[140px] truncate">{containerLabel}</span>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="min-w-[160px] max-h-[50vh] overflow-y-auto [scrollbar-width:thin] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar]:block [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border"
            >
              <DropdownMenuRadioGroup
                value={remoteContainerId}
                onValueChange={setRemoteContainerId}
              >
                <DropdownMenuRadioItem value="">
                  {t("remote.targetHost", { defaultValue: "宿主机" })}
                </DropdownMenuRadioItem>
                {containers.length > 0 && (
                  <>
                    <DropdownMenuSeparator />
                    {containers.map((c) => (
                      <DropdownMenuRadioItem key={c} value={c}>
                        {c}
                      </DropdownMenuRadioItem>
                    ))}
                  </>
                )}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      )}
    </div>
  );
}
