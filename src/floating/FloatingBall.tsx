import { useCallback, useEffect, useState } from "react";
import type { PointerEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Pin } from "lucide-react";
import { APP_ICON_MAP } from "@/config/appConfig";
import { type FloatingEntry, type FloatingUsageData } from "./types";

/** app 小图标：按当前 appType 取主应用对应品牌图标（与主窗口 APP_ICON_MAP 一致）。 */
function AppIcon({ size, appType }: { size: number; appType: string }) {
  const cfg = APP_ICON_MAP[appType as keyof typeof APP_ICON_MAP];
  if (!cfg?.icon) return null;
  return (
    <span
      style={{
        width: size,
        height: size,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        color: "currentColor",
      }}
    >
      {cfg.icon}
    </span>
  );
}

interface Summary {
  level: UsageLevel;
  color: string;
  /** app 类型 key（claude/codex/gemini/...），用于取对应品牌图标 */
  appType: string;
  app: string;
  /** 是否手动置顶（面板/设置页图钉圈定）；置顶时球显示小图钉 */
  isPinned: boolean;
  /** 当前 app 是否处「远端接管」；是则球显示流动边框 */
  takeoverActive: boolean;
  provider: string;
  model: string;
  /** 余量数值（状态色；单套餐用） */
  usageValue: string;
  /** 单位（如 CNY / GB，灰色，与主窗口一致） */
  usageUnit: string;
  /** 多套餐订阅：每行一个套餐缩写（如 h5% / d20% / m30%），右半区三行显示 */
  usageLines: string[] | null;
}

type UsageLevel = "danger" | "warn" | "good" | "none";

/**
 * 镜像主窗口 UsageFooter 规则（与托盘/卡片/面板一致）：
 * `isValid === false` → danger；`remaining < (total || remaining) * 0.1` → warn；否则 good。
 * 多套餐时取所有套餐里最差的一个（任一过期→danger，任一低于阈值→warn）。
 * 副作用与主窗口一致：0 余额无过期标记 → good；负余额 → warn。
 */
function worstUsageLevel(usage: FloatingUsageData[] | null): UsageLevel {
  if (!usage || usage.length === 0) return "none";
  let warn = false;
  for (const d of usage) {
    if (d.isValid === false) return "danger";
    const remaining = d.remaining;
    if (remaining != null && isFinite(remaining)) {
      const threshold = (d.total || remaining) * 0.1;
      if (remaining < threshold) warn = true;
    }
  }
  return warn ? "warn" : "good";
}

/** 圆点色号：danger/warn/good 与主窗口 red/orange/green 一致，none 用灰 */
function ballStatusColor(level: UsageLevel): string {
  switch (level) {
    case "danger":
      return "#ef4444";
    case "warn":
      return "#f97316";
    case "good":
      return "#16a34a";
    default:
      return "#94a3b8";
  }
}

/** 套餐名 → 缩写（小时/天/周/月/年；匹配不到返回空） */
function planAbbr(name?: string | null): string {
  const n = name?.toLowerCase() ?? "";
  if (/hour|小时/.test(n)) return "h";
  if (/week|周/.test(n)) return "w";
  if (/day|天/.test(n)) return "d";
  if (/month|月/.test(n)) return "m";
  if (/year|年/.test(n)) return "y";
  return "";
}

/** 悬浮球当前应显示的目标 app（由后端解析：置顶优先，否则最近活跃 app） */
export interface FloatingBallTarget {
  appType: string;
  isPinned: boolean;
  appLabel: string;
  takeoverActive: boolean;
}

/** 读取悬浮球目标 app 的供应商 / 模型 / 余量。
 *  只用两个轻量命令（get_floating_ball_detail 只查目标一个 app、get_floating_ball_target
 *  只回 app/isPinned），避免面板全量扫描拖慢球的响应。 */
async function loadSummary(): Promise<Summary> {
  const [entry, target] = (await Promise.all([
    invoke("get_floating_ball_detail") as Promise<FloatingEntry | null>,
    invoke("get_floating_ball_target") as Promise<FloatingBallTarget | null>,
  ])) as [FloatingEntry | null, FloatingBallTarget | null];

  const isPinned = !!target?.isPinned;
  const takeoverActive = !!target?.takeoverActive;

  if (!entry)
    return {
      level: "none",
      color: "#94a3b8",
      appType: target?.appType ?? "claude",
      app: target?.appLabel ?? "CC",
      isPinned,
      takeoverActive,
      provider: "—",
      model: "—",
      usageValue: "—",
      usageUnit: "",
      usageLines: null,
    };

  // 多套餐订阅（≥2 个）：右半区每行一个套餐缩写（如 h5% / d20% / m30%）
  let usageValue: string;
  let usageUnit = "";
  let usageLines: string[] | null = null;
  if (entry.usage && entry.usage.length > 1) {
    usageLines = entry.usage.map((u) => {
      const r = u.remaining ?? 0;
      return `${planAbbr(u.planName)}${Math.round(r)}%`;
    });
    usageValue = "";
  } else {
    const d = entry.usage?.[0];
    if (d && d.remaining != null && isFinite(d.remaining)) {
      usageValue = d.remaining.toFixed(2);
      usageUnit = d.unit ?? "";
    } else {
      usageValue = entry.usageSummary ?? "未设置";
    }
  }

  const level = worstUsageLevel(entry.usage);
  return {
    level,
    color: ballStatusColor(level),
    appType: entry.appType,
    app: entry.appLabel,
    isPinned,
    takeoverActive,
    provider: entry.providerName ?? "",
    model: entry.model ?? "",
    usageValue,
    usageUnit,
    usageLines,
  };
}

/**
 * 悬浮球（方案C：240×56 横向胶囊条，本身就是信息条——左 app/模型，右 余量）：
 * - 拖动：按下/松开只发信号给 Rust，Rust 用 GetCursorPos 轮询全局光标 + set_position
 *   移动窗口（绕开 WebView 事件），松手自动吸附，无位移即单击→打开主窗口
 * - 悬停展开面板，离开时通知后端宽限隐藏
 */
export function FloatingBall() {
  const [summary, setSummary] = useState<Summary>({
    level: "none",
    color: "#94a3b8",
    appType: "claude",
    app: "CC",
    isPinned: false,
    takeoverActive: false,
    provider: "—",
    model: "—",
    usageValue: "—",
    usageUnit: "",
    usageLines: null,
  });

  const refresh = useCallback(() => {
    loadSummary()
      .then(setSummary)
      .catch((e) => console.error("[Floating] 刷新数据失败", e));
  }, []);

  useEffect(() => {
    refresh();
    const unlisteners: Array<() => void> = [];

    // provider-switched：记录最近活跃 app（供未置顶时跟随）+ 刷新球
    void listen<{ appType?: string }>("provider-switched", (ev) => {
      const appType = ev.payload?.appType;
      if (appType) {
        void invoke("floating_record_active_app", { appType }).catch((e) =>
          console.error("[Floating] 记录活跃 app 失败", e),
        );
      }
      refresh();
    }).then((u) => unlisteners.push(u));
    // 置顶/跟随目标变化：用轻量命令立刻刷新球，不等全量 data-refresh
    void listen("floating-pin-changed", refresh).then((u) =>
      unlisteners.push(u),
    );
    void listen("floating-data-refresh", refresh).then((u) =>
      unlisteners.push(u),
    );
    void listen("usage-cache-updated", refresh).then((u) =>
      unlisteners.push(u),
    );
    // 可靠性兜底：实测跨窗口事件（含 emit_to）到悬浮球 webview 不可靠，球常只按
    // 轮询刷新；get_floating_ball_detail 已改为单 app 轻量查询，1s 轮询成本可忽略，
    // 保证置顶/跟随任何变化 ≤1s 生效。
    const timer = setInterval(refresh, 1_000);
    return () => {
      clearInterval(timer);
      unlisteners.forEach((u) => u());
    };
  }, [refresh]);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    void invoke("floating_drag_begin").catch((err) =>
      console.error("[Floating] 拖动开始失败", err),
    );
  };

  return (
    <div
      className={`ball${summary.takeoverActive ? " route-service-live" : ""}`}
      title={summary.takeoverActive ? "此 app 正处远端接管，请求经本机代理/远端隧道转发" : undefined}
      onPointerDown={onPointerDown}
      onPointerUp={() => void invoke("floating_drag_end")}
      onPointerCancel={() => void invoke("floating_drag_end")}
      onContextMenu={(e) => {
        e.preventDefault();
        void invoke("show_floating_context_menu").catch((err) =>
          console.error("[Floating] 打开右键菜单失败", err),
        );
      }}
    >
      {/* 左区：状态圆点（绿/橙/红）单独一列 */}
      <span
        className="ball-status-col"
        style={{ background: summary.color }}
        title={`${summary.usageValue}${summary.usageUnit ? ` ${summary.usageUnit}` : ""}`}
      />
      {/* 中区：app 图标 + 名 + 图钉 + 供应商蓝底球标（原左区内容） */}
      <div className="ball-left">
        <span className="ball-app">
          <AppIcon size={10} appType={summary.appType} />
          <span className="ball-app-text">{summary.app}</span>
          {summary.isPinned && (
            <span className="ball-pin" title="已置顶此 app" aria-label="已置顶">
              <Pin size={9} />
            </span>
          )}
        </span>
        <span className="ball-model">
          {/* 只显示供应商；用模型那套淡品牌蓝底蓝字突出，模型名工具内已可见不重复 */}
          {summary.provider ? (
            <span className="ball-tag ball-tag-model">{summary.provider}</span>
          ) : (
            <span>—</span>
          )}
        </span>
      </div>
      <span
        className={
          summary.usageLines ? "ball-usage ball-usage-multi" : "ball-usage"
        }
      >
        {summary.usageLines ? (
          summary.usageLines.map((line, i) => (
            <span
              key={i}
              className={
                summary.level === "none"
                  ? undefined
                  : `usage-value-${summary.level}`
              }
            >
              {line}
            </span>
          ))
        ) : (
          <>
            <span
              className={
                summary.level === "none"
                  ? undefined
                  : `usage-value-${summary.level}`
              }
            >
              {summary.usageValue}
            </span>
            {summary.usageUnit && (
              <span className="ball-usage-unit">{summary.usageUnit}</span>
            )}
          </>
        )}
      </span>
    </div>
  );
}
