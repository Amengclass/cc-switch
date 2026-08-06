import { useCallback, useEffect, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Clock } from "lucide-react";
import {
  statusColor,
  usageValueClass,
  type FloatingEntry,
  type FloatingUsageData,
} from "./types";

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
  // 相对时间基准，每 30s 推进一次（与主窗口 UsageFooter 相同节奏）
  const [now, setNow] = useState(Date.now());

  const refresh = useCallback(async () => {
    try {
      const data = (await invoke(
        "get_floating_window_data",
      )) as FloatingEntry[];
      setEntries(data);
    } catch (e) {
      console.error("[Floating] 面板加载失败", e);
    } finally {
      setLoading(false);
    }
  }, []);

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
      onMouseEnter={() =>
        void invoke("floating_set_hover", { source: "panel", active: true })
      }
      onMouseLeave={() =>
        void invoke("floating_set_hover", { source: "panel", active: false })
      }
      // 面板是纯展示，右键不弹任何东西（含 WebView 默认菜单）
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
                  <span className="row-app">{e.appLabel}</span>
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
