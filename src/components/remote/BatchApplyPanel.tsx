import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  CheckCircle2,
  ChevronRight,
  Container,
  Loader2,
  Search,
  Send,
  Server,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { FullScreenPanel } from "@/components/common/FullScreenPanel";
import { cn } from "@/lib/utils";
import type { RemoteHost } from "@/types/remote";
import type { Provider } from "@/types";
import {
  broadcastSwitchProvider,
  listDockerContainers,
} from "@/lib/api/remote";

interface Target {
  hostId: string;
  hostName: string;
  container?: string;
}

interface BatchApplyPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  app: string;
  hosts: RemoteHost[];
  providers: Record<string, Provider>;
  defaultProviderId?: string | null;
}

interface ResultRow {
  key: string;
  label: string;
  status: "pending" | "running" | "ok" | "fail";
  message?: string;
}

const contKey = (id: string, c: string) => `${id}::${c}`;
const splitKey = (key: string) => key.split("::");

/** 批量应用 Provider 面板：搜索 + 整台勾选（含容器）+ 顶部已选 chips + 逐落点切换 */
export function BatchApplyPanel({
  open,
  onOpenChange,
  app,
  hosts,
  providers,
  defaultProviderId,
}: BatchApplyPanelProps) {
  const { t } = useTranslation();

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [containersMap, setContainersMap] = useState<
    Record<string, string[] | null>
  >({});
  const [search, setSearch] = useState<string>("");
  const [providerId, setProviderId] = useState<string>("");
  const [results, setResults] = useState<ResultRow[]>([]);
  const [running, setRunning] = useState(false);
  // 卡片②「已选清单」是否展开（b1：默认紧凑，点开看全）
  const [showSelected, setShowSelected] = useState(false);

  const providerList = useMemo(() => Object.values(providers), [providers]);

  useEffect(() => {
    if (open) {
      setProviderId(defaultProviderId ?? providerList[0]?.id ?? "");
      setSelected(new Set());
      setExpanded(new Set());
      setContainersMap({});
      setSearch("");
      setResults([]);
      setRunning(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // 打开面板即批量拉取所有主机的容器列表：每台行尾常驻显示「N 容器」，无需逐个展开
  useEffect(() => {
    if (!open || hosts.length === 0) return;
    let alive = true;
    setContainersMap({});
    hosts.forEach((host) => {
      listDockerContainers(host.id)
        .then((list) => {
          if (alive)
            setContainersMap((prev) => ({ ...prev, [host.id]: list }));
        })
        .catch(() => {
          if (alive)
            setContainersMap((prev) => ({ ...prev, [host.id]: [] }));
        });
    });
    return () => {
      alive = false;
    };
  }, [open, hosts]);

  const toggleExpand = async (host: RemoteHost) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(host.id)) next.delete(host.id);
      else next.add(host.id);
      return next;
    });
    if (!(host.id in containersMap)) {
      setContainersMap((prev) => ({ ...prev, [host.id]: null }));
      try {
        const list = await listDockerContainers(host.id);
        setContainersMap((prev) => ({ ...prev, [host.id]: list }));
      } catch {
        setContainersMap((prev) => ({ ...prev, [host.id]: [] }));
      }
    }
  };

  const filteredHosts = useMemo(() => {
    const kw = search.trim().toLowerCase();
    if (!kw) return hosts;
    return hosts.filter(
      (h) =>
        h.name.toLowerCase().includes(kw) || h.host.toLowerCase().includes(kw),
    );
  }, [hosts, search]);

  const toggleContainer = (hostId: string, container: string) => {
    const key = contKey(hostId, container);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleHost = (host: RemoteHost) => {
    const cs = containersMap[host.id] ?? [];
    setSelected((prev) => {
      const next = new Set(prev);
      const wasFull = next.has(host.id);
      if (wasFull) {
        next.delete(host.id);
        cs.forEach((c) => next.delete(contKey(host.id, c)));
      } else {
        next.add(host.id);
        cs.forEach((c) => next.add(contKey(host.id, c)));
      }
      return next;
    });
  };

  const isHostFullyChecked = (host: RemoteHost) => {
    const cs = containersMap[host.id] ?? [];
    if (!selected.has(host.id)) return false;
    return cs.length === 0 || cs.every((c) => selected.has(contKey(host.id, c)));
  };

  // 展开区「宿主机账号」行：只切换 host.id（不连容器）
  const toggleHostOnly = (hostId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(hostId)) next.delete(hostId);
      else next.add(hostId);
      return next;
    });
  };

  const selectedTargets: Target[] = useMemo(() => {
    const list: Target[] = [];
    for (const key of selected) {
      const [hostId, container] = splitKey(key);
      const host = hosts.find((h) => h.id === hostId);
      if (!host) continue;
      list.push({ hostId, hostName: host.name, container });
    }
    return list;
  }, [selected, hosts]);

  const doApply = async () => {
    if (selectedTargets.length === 0 || !providerId) return;
    setRunning(true);
    const rows: ResultRow[] = selectedTargets.map((t) => ({
      key: t.container ? `${t.hostId}::${t.container}` : t.hostId,
      label: t.container ? `${t.hostName} / ${t.container}` : t.hostName,
      status: "pending",
    }));
    setResults(rows);

    // 一次调用后端广播命令，逐落点聚合结果（后端逐落点建连切换，失败不阻断其它）
    try {
      const results = await broadcastSwitchProvider(
        selectedTargets.map((t) => ({
          hostId: t.hostId,
          container: t.container ?? null,
        })),
        providerId,
        app,
      );
      setResults(
        results.map((res) => ({
          key: res.container ? `${res.hostId}::${res.container}` : res.hostId,
          label: res.label,
          status: res.ok ? "ok" : "fail",
          message: res.ok ? res.providerName : (res.error ?? "切换失败"),
        })),
      );
    } catch (e) {
      // 整个广播调用崩了（如参数错误）：全标失败
      setResults(
        rows.map((r) => ({ ...r, status: "fail", message: String(e) })),
      );
    }
    setRunning(false);
  };

  return (
    <FullScreenPanel
      isOpen={open}
      title="批量应用 Provider"
      onClose={() => onOpenChange(false)}
      contentClassName="px-6 py-6 space-y-6 w-full"
      footer={
        <>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={running}
          >
            取消
          </Button>
          <Button
            disabled={
              running ||
              selectedTargets.length === 0 ||
              !providerId ||
              providerList.length === 0
            }
            onClick={() => void doApply()}
          >
            {running ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Send className="mr-2 h-4 w-4" />
            )}
            批量应用 ({selectedTargets.length})
          </Button>
        </>
      }
    >
      {/* ① 选落点 */}
      <div className="glass rounded-xl p-6 border border-white/10 space-y-6 flex-shrink-0">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-foreground/60 mb-4">
          选落点 · 勾整台 = 含其容器
        </h4>

        <div className="space-y-2">
          <div className="flex items-center gap-2 rounded-md border border-border/60 bg-background px-2.5 py-1.5 focus-within:ring-1 focus-within:ring-primary/40">
            <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索主机名 / 地址…"
              className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>
        </div>

        <div className="h-[40vh] space-y-1 overflow-y-auto pr-1 [scrollbar-width:thin] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar]:block [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border">
          {filteredHosts.length === 0 && (
            <div className="py-8 text-center text-sm text-muted-foreground">
              {hosts.length === 0
                ? "暂无远程主机，请在「远程主机管理」中添加"
                : "无匹配主机"}
            </div>
          )}
          {filteredHosts.map((host) => {
            const cs = containersMap[host.id];
            const fullyChecked = isHostFullyChecked(host);
            return (
              <div
                key={host.id}
                className={cn(
                  "rounded-md border transition-colors",
                  fullyChecked
                    ? "border-primary/50 bg-primary/5"
                    : "border-border/40",
                )}
              >
                <div className="flex items-center gap-2 px-2 py-2">
                  <Checkbox
                    checked={fullyChecked}
                    onCheckedChange={() => toggleHost(host)}
                  />
                  <Server className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <button
                    type="button"
                    onClick={() => void toggleExpand(host)}
                    className="flex min-w-0 flex-1 items-center gap-1 text-left text-sm font-medium"
                  >
                    <ChevronRight
                      className={cn(
                        "h-3.5 w-3.5 shrink-0 text-muted-foreground/60 transition-transform",
                        expanded.has(host.id) && "rotate-90",
                      )}
                    />
                    <span className="truncate">{host.name}</span>
                  </button>
                  {cs != null && cs.length > 0 && (
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {cs.length} 容器
                    </span>
                  )}
                  {cs === null && (
                    <Loader2 className="ml-auto h-3.5 w-3.5 animate-spin text-muted-foreground/60" />
                  )}
                </div>
                {expanded.has(host.id) && (
                  <div className="space-y-1 border-l border-border/60 pl-4 pb-2">
                    {/* 宿主机账号：与容器并列，代表该宿主机本身（仅账号，不含容器），主色标识 */}
                    <label className="flex cursor-pointer items-center gap-2 px-2 py-1 text-sm">
                      <Checkbox
                        checked={selected.has(host.id)}
                        onCheckedChange={() => toggleHostOnly(host.id)}
                      />
                      <Server className="h-3.5 w-3.5 shrink-0 text-primary" />
                      <span className="truncate font-medium text-primary">宿主机</span>
                    </label>
                    <div className="border-t border-border/50" />
                    {cs && cs.length === 0 && (
                      <div className="px-2 py-1 text-xs text-muted-foreground">
                        无容器（或不可用）
                      </div>
                    )}
                    {(cs ?? []).map((c) => (
                      <label
                        key={c}
                        className="flex cursor-pointer items-center gap-2 px-2 py-1 text-sm text-muted-foreground"
                      >
                        <Checkbox
                          checked={selected.has(contKey(host.id, c))}
                          onCheckedChange={() => toggleContainer(host.id, c)}
                        />
                        <Container className="h-3.5 w-3.5 shrink-0" />
                        <span className="truncate">{c}</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>

      </div>

      {/* ② 选择 Provider + 执行结果 */}
      <div className="glass rounded-xl p-6 border border-white/10 space-y-6 flex-shrink-0">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-foreground/60 mb-4">
          应用到 · Provider
        </h4>
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm font-medium text-foreground/80">
            {providers[providerId]?.name ?? "（请选择 Provider）"}
          </span>
          <select
            value={providerId}
            onChange={(e) => setProviderId(e.target.value)}
            className="h-9 max-w-[240px] rounded-lg border border-border/40 bg-background px-2.5 text-sm font-medium text-foreground outline-none focus:ring-1 focus:ring-primary/40"
          >
            {providerList.length === 0 && (
              <option value="">（无可用 Provider）</option>
            )}
            {providerList.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>

        {/* 已选清单（b1：默认只显示计数，点开展开具体落点） */}
        {selectedTargets.length > 0 && (
          <div className="border-t border-border/60 pt-4">
            <button
              type="button"
              onClick={() => setShowSelected((v) => !v)}
              className="flex w-full items-center justify-between text-sm text-foreground/80 hover:text-foreground"
            >
              <span>
                已选 <span className="font-semibold text-primary">{selectedTargets.length}</span> 个落点
              </span>
              <ChevronRight
                className={cn(
                  "h-4 w-4 shrink-0 text-muted-foreground transition-transform",
                  showSelected && "rotate-90",
                )}
              />
            </button>
            {showSelected && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {selectedTargets.map((t) => {
                  const isContainer = !!t.container;
                  return (
                    <span
                      key={t.container ? contKey(t.hostId, t.container) : t.hostId}
                      className={cn(
                        "inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs",
                        isContainer
                          ? "bg-muted text-muted-foreground"
                          : "bg-primary/10 text-primary",
                      )}
                    >
                      {isContainer ? (
                        <Container className="h-3 w-3 shrink-0" />
                      ) : (
                        <Server className="h-3 w-3 shrink-0" />
                      )}
                      <span>{t.container ? t.container : t.hostName}</span>
                      {!isContainer && (
                        <span className="opacity-70">宿主机</span>
                      )}
                    </span>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {results.length > 0 && (
          <div className="mt-5 space-y-1">
            {results.map((r) => (
              <div
                key={r.key}
                className="flex items-center gap-2 rounded-md border border-border/40 px-2 py-1.5 text-sm"
              >
                {r.status === "pending" && (
                  <span className="h-3.5 w-3.5 shrink-0 rounded-full bg-muted-foreground/30" />
                )}
                {r.status === "running" && (
                  <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
                )}
                {r.status === "ok" && (
                  <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
                )}
                {r.status === "fail" && (
                  <XCircle className="h-3.5 w-3.5 shrink-0 text-red-500" />
                )}
                <span className="min-w-0 flex-1 truncate">{r.label}</span>
                {r.status === "ok" && (
                  <span className="text-xs text-muted-foreground">已切换</span>
                )}
                {r.status === "fail" && (
                  <span className="max-w-[40%] truncate text-xs text-red-500">
                    {r.message}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
            </div>
    </FullScreenPanel>
  );
}
