import { cloneElement, useCallback, useEffect, useState, type ReactNode } from "react";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
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

/** 套餐名 → 缩写（只有 h/w/m 维度，无天）。返回空则不显示维度前缀。 */
function planAbbr(name?: string | null): string {
  const n = name?.toLowerCase() ?? "";
  if (/hour|小时/.test(n)) return "h";
  if (/week|周/.test(n)) return "w";
  if (/month|月/.test(n)) return "m";
  return "";
}

/** 相对时间：与主窗口 UsageFooter formatRelativeTime 同语义（传 t，语言切换即时生效） */
function formatRelativeTime(
  ts: number | null,
  now: number,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  if (ts == null) return t("floating.neverUpdated");
  const diff = Math.floor((now - ts) / 1000);
  if (diff < 60) return t("floating.justNow");
  if (diff < 3600) return t("floating.minutesAgo", { count: Math.floor(diff / 60) });
  if (diff < 86400) return t("floating.hoursAgo", { count: Math.floor(diff / 3600) });
  return t("floating.daysAgo", { count: Math.floor(diff / 86400) });
}

/**
 * 单个用量数据 → 主窗口 UsageFooter 同款结构：标签灰、数值状态色+等宽数字、单位灰。
 * showPlan 用于多套餐的补行（主窗口完整模式有套餐名，inline 主行没有）。
 */
function UsageDetail({
  d,
  showPlan = false,
  dimPrefix,
  t,
}: {
  d: FloatingUsageData;
  showPlan?: boolean;
  /** 主用量的维度前缀（如 "h"），渲染成「剩余：h 100%」 */
  dimPrefix?: string;
  t: (key: string, opts?: Record<string, unknown>) => string;
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
        <span className="usage-label">{t("floating.used")}</span>
        <span className="usage-value">{d.used!.toFixed(2)}</span>
      </span>,
    );
  }
  if (hasRemaining) {
    nodes.push(
      <span key="rem" className="usage-item">
        <span className="usage-label">{t("floating.remaining")}</span>
        <span className={`usage-value ${usageValueClass(d)}`}>
          {dimPrefix ? `${dimPrefix} ` : ""}
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
  const { t } = useTranslation();
  const [entries, setEntries] = useState<FloatingEntry[]>([]);
  const [loading, setLoading] = useState(true);
  /** 当前置顶到悬浮窗的 app（未置顶 = null；每行据此高亮图钉） */
  const [pinnedApp, setPinnedApp] = useState<string | null>(null);
  // 相对时间基准，每 30s 推进一次（与主窗口 UsageFooter 相同节奏）
  const [now, setNow] = useState(Date.now());

  // 读取悬浮窗当前置顶的 app（与球同源：get_floating_ball_target）
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

  // 逐行置顶/取消置顶悬浮窗显示。乐观更新：先本地置 `pinnedApp` 让按钮立即响应，
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
        <span className="panel-sub">{t("floating.currentProviderUsage")}</span>
      </div>

      <div className="panel-list">
        {entries.map((e) => {
          const hasUsage = e.usage && e.usage.length > 0;
          const extraItems =
            hasUsage && e.usage!.length > 1 ? e.usage!.slice(1) : [];
          return (
            <div key={e.appType}>
              <div
                className={`row${e.takeoverActive ? " row-takeover" : ""}`}
                title={e.takeoverActive ? t("floating.takeoverActive") : undefined}
              >
                <div className="row-left">
                  <span className="row-app">
                    <span className="row-app-icon">
                      <AppIcon size={11} appType={e.appType} />
                    </span>
                    {e.appLabel}
                  </span>
                  <span className="row-provider-line">
                    {/* 供应商：淡蓝底胶囊；模型：灰色小字，二者分开避免叠在一起 */}
                    {e.hasProvider ? (
                      <span className="row-provider row-provider-set">
                        {e.providerName}
                      </span>
                    ) : (
                      <span className="row-provider">{e.providerName}</span>
                    )}
                    {e.model ? (
                      <span className="row-model">{e.model}</span>
                    ) : null}
                  </span>
                </div>
                <span
                  className="row-usage"
                  style={
                    hasUsage ? undefined : { color: statusColor(e.worstPct) }
                  }
                >
                  {/* 统一余量列：时间在上、主用量在下、多套餐 chips 横向铺开，
                      全列右对齐，每行视觉一致 */}
                  {hasUsage ? (
                    <>
                      <span className="usage-time">
                        <Clock size={10} />
                        {formatRelativeTime(e.queriedAt, now, t)}
                      </span>
                      <UsageDetail
                        d={e.usage![0]}
                        dimPrefix={
                          planAbbr(e.usage![0].planName) || undefined
                        }
                        t={t}
                      />
                      {extraItems.length > 0 && (
                        <span className="usage-chips">
                          {extraItems.map((d, i) => {
                            const r = d.remaining;
                            const hasVal = r != null && isFinite(r);
                            return (
                              <span className="usage-chip" key={i}>
                                {d.planName ? (
                                  <span className="usage-chip-plan">
                                    {planAbbr(d.planName)}
                                  </span>
                                ) : null}
                                {hasVal ? (
                                  <span className={usageValueClass(d)}>
                                    {Math.round(r!)}%
                                  </span>
                                ) : (
                                  <span>—</span>
                                )}
                              </span>
                            );
                          })}
                        </span>
                      )}
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
                      ? t("floating.unpinTitle", { app: e.appLabel })
                      : t("floating.pinTitle", { app: e.appLabel })
                  }
                  aria-label={
                    pinnedApp === e.appType
                      ? t("floating.unpin")
                      : t("floating.pin")
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
            </div>
          );
        })}
        {entries.length === 0 && !loading && (
          <div className="empty">{t("floating.noData")}</div>
        )}
      </div>
    </div>
  );
}
