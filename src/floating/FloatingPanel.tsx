import { cloneElement, useCallback, useEffect, useState, type ReactNode } from "react";
import type { ReactElement } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Clock, Pin } from "lucide-react";
import { APP_ICON_MAP } from "@/config/appConfig";
import {
  statusColor,
  usageValueClass,
  type FloatingEntry,
  type FloatingUsageData,
} from "./types";
import type { FloatingBallTarget } from "./FloatingBall";

/** app 小图标：按 appType 取主应用品牌图标，统一成指定尺寸（配合行/app 名显示）。 */
function AppIcon({ size, appType }: { size: number; appType: string }) {
  const cfg = APP_ICON_MAP[appType as keyof typeof APP_ICON_MAP];
  if (!cfg?.icon) return null;
  return cloneElement(cfg.icon as ReactElement<{ size?: number }>, { size });
}

/** 相对时间：与主窗口 UsageFooter formatRelativeTime 同语义（悬浮窗硬编码中文） */
function formatRelativeTime(ts: number | null, now: number): string {
  if (ts == null) return "从未更新";
  const diff = Math.floor((now - ts) / 1000);
  if (diff < 60) return "刚刚";
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  return `${Math.floor(diff / 86400)} 天前`;
}

/**
 * 单个用量数据 → 主窗口 UsageFooter 同款结构：标签灰、数值状态色+等宽数字、单位灰。
 * showPlan 用于多套餐的补行（主窗口完整模式有套餐名，inline 主行没有）。
 */
function UsageDetail({
  d,
  showPlan = false,
}: {
  d: FloatingUsageData;
  showPlan?: boolean;
}) {
  const hasRemaining = d.remaining != null && isFinite(d.remaining);
  const hasUsed = d.used != null && isFinite(d.used);
  const nodes: ReactNode[] = [];

  if (d.planName && showPlan) {
    nodes.push(
      <span key="plan" className="usage-plan">
        {d.planName}
      </span>,
    );
  }
  if (hasUsed) {
    nodes.push(
      <span key="used" className="usage-item">
        <span className="usage-label">已用：</span>
        <span className="usage-value">{d.used!.toFixed(2)}</span>
      </span>,
    );
  }
  if (hasRemaining) {
    nodes.push(
      <span key="rem" className="usage-item">
        <span className="usage-label">剩余：</span>
        <span className={`usage-value ${usageValueClass(d)}`}>
          {d.remaining!.toFixed(2)}
        </span>
        {d.unit && <span className="usage-unit">{d.unit}</span>}
      </span>,
    );
  }
  if (d.extra) {
    nodes.push(
      <span key="extra" className="usage-extra">
        {d.extra}
      </span>,
    );
  }
  return <span className="usage-line">{nodes}</span>;
}

/**
 * 用量面板（300×320 透明窗）：
 * - 展示每个可见 app 的供应商 / 模型 / 用量汇总
 * - 显示时拉数据 + 3s 轮询 + 事件驱动刷新
 * - 悬停面板时通知后端保持显示（跨窗宽限）
 */
export function FloatingPanel() {
  const [entries, setEntries] = useState<FloatingEntry[]>([]);
  const [loading, setLoading] = useState(true);
  /** 当前置顶到悬浮球的 app（未置顶 = null；每行据此高亮图钉） */
  const [pinnedApp, setPinnedApp] = useState<string | null>(null);
  // 相对时间基准，每 30s 推进一次（与主窗口 UsageFooter 相同节奏）
  const [now, setNow] = useState(Date.now());

  // 读取悬浮球当前置顶的 app（与球同源：get_floating_ball_target）
  const reloadPin = useCallback(() => {
    void (invoke("get_floating_ball_target") as Promise<FloatingBallTarget | null>)
      .then((t) => setPinnedApp(t?.isPinned ? t.appType : null))
      .catch((e) => console.error("[Floating] 读取置顶 app 失败", e));
  }, []);

  const refresh = useCallback(async () => {
    try {
      const data = (await invoke(
        "get_floating_window_data",
      )) as FloatingEntry[];
      setEntries(data);
      reloadPin();
    } catch (e) {
      console.error("[Floating] 面板加载失败", e);
    } finally {
      setLoading(false);
    }
  }, [reloadPin]);

  // 逐行置顶/取消置顶悬浮球显示。乐观更新：先本地置 `pinnedApp` 让按钮立即响应，
  // 再写后端（settings 落盘 + 发事件驱动球/设置页刷新）。
  const togglePin = useCallback((appType: string, currentlyPinned: boolean) => {
    const next = currentlyPinned ? null : appType;
    setPinnedApp(next);
    void invoke("floating_set_pin_app", { appType: next })
      .catch((e) => {
        console.error("[Floating] 设置置顶失败", e);
        // 失败回滚到后端真实值，避免按钮停留在错误的置顶态
        reloadPin();
      });
  }, [reloadPin]);

  useEffect(() => {
    void refresh();
    const unlisteners: Array<() => void> = [];
    void listen("floating-data-refresh", refresh).then((u) =>
      unlisteners.push(u),
    );
    void listen("provider-switched", refresh).then((u) => unlisteners.push(u));
    void listen("usage-cache-updated", refresh).then((u) =>
      unlisteners.push(u),
    );
    // 高频轮询作为事件兜底：隐藏窗口若收不到事件，3s 内也能同步到
    // 主窗口最新的供应商/余量（get_floating_window_data 只读本地缓存）。
    const timer = setInterval(refresh, 3_000);
    const nowTimer = setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      clearInterval(timer);
      clearInterval(nowTimer);
      unlisteners.forEach((u) => u());
    };
  }, [refresh]);

  return (
    <div
      className="panel"
      // hover 状态由 floating-main.tsx 的窗口级覆盖层统一上报（含透明留白区），
      // 这里不再绑定 mouseenter/leave，避免移到面板边缘透明区时面板闪没。
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="panel-header">
        <span className="panel-title">CC Switch</span>
        <span className="panel-sub">当前供应商 · 用量</span>
      </div>

      <div className="panel-list">
        {entries.map((e) => {
          const hasUsage = e.usage && e.usage.length > 0;
          const extraItems =
            hasUsage && e.usage!.length > 1 ? e.usage!.slice(1) : [];
          return (
            <div key={e.appType}>
              <div className="row">
                <div className="row-left">
                  <span className="row-app">
                    <span className="row-app-icon">
                      <AppIcon size={11} appType={e.appType} />
                    </span>
                    {e.appLabel}
                  </span>
                  <span
                    className={
                      e.hasProvider
                        ? "row-provider row-provider-set"
                        : "row-provider"
                    }
                  >
                    {e.providerName}
                    {e.model ? ` · ${e.model}` : ""}
                  </span>
                </div>
                <span
                  className="row-usage"
                  style={
                    hasUsage ? undefined : { color: statusColor(e.worstPct) }
                  }
                >
                  {hasUsage ? (
                    <>
                      <span className="usage-time">
                        <Clock size={10} />
                        {formatRelativeTime(e.queriedAt, now)}
                      </span>
                      <UsageDetail d={e.usage![0]} />
                    </>
                  ) : (
                    (e.usageSummary ?? "—")
                  )}
                </span>
                <button
                  type="button"
                  className={
                    pinnedApp === e.appType
                      ? "row-pin row-pin-active"
                      : "row-pin"
                  }
                  title={
                    pinnedApp === e.appType
                      ? `取消置顶「${e.appLabel}」到悬浮球`
                      : `置顶「${e.appLabel}」到悬浮球`
                  }
                  aria-label={
                    pinnedApp === e.appType
                      ? "取消置顶到悬浮球"
                      : "置顶到悬浮球"
                  }
                  onClick={() =>
                    togglePin(e.appType, pinnedApp === e.appType)
                  }
                >
                  <Pin
                    size={11}
                    fill={pinnedApp === e.appType ? "currentColor" : "none"}
                  />
                </button>
              </div>
              {extraItems.length > 0 && (
                <div className="row-sub">
                  {extraItems.map((d, i) => (
                    <div className="row-sub-item" key={i}>
                      <UsageDetail d={d} showPlan />
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
        {entries.length === 0 && !loading && (
          <div className="empty">暂无数据</div>
        )}
      </div>

      <div className="panel-footer">
        <button onClick={() => void invoke("open_main_window")}>
          打开主界面
        </button>
        <button onClick={() => void invoke("disable_floating_window")}>
          关闭悬浮窗
        </button>
      </div>
    </div>
  );
}
