import { useCallback, useEffect, useMemo, useState } from "react";
import type { PointerEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getIcon } from "@/icons/extracted";
import { type FloatingEntry, type FloatingUsageData } from "./types";

/** app 小图标：取主应用品牌内联 SVG，内联样式渲染（悬浮窗不加载 tailwind） */
function AppIcon({ size }: { size: number }) {
  const svg = useMemo(() => getIcon("claude"), []);
  if (!svg) return null;
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
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

interface Summary {
  level: UsageLevel;
  color: string;
  app: string;
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

/** 读取 Claude Code 的 app / 供应商 / 模型 / 余量 */
async function loadSummary(): Promise<Summary> {
  const entries = (await invoke("get_floating_window_data")) as FloatingEntry[];
  const entry = entries.find((e) => e.appType === "claude");
  if (!entry)
    return {
      level: "none",
      color: "#94a3b8",
      app: "CC",
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
    app: entry.appLabel,
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
    app: "CC",
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
    void listen("floating-data-refresh", refresh).then((u) =>
      unlisteners.push(u),
    );
    void listen("provider-switched", refresh).then((u) => unlisteners.push(u));
    void listen("usage-cache-updated", refresh).then((u) =>
      unlisteners.push(u),
    );
    const timer = setInterval(refresh, 5_000);
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
      className="ball"
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
      <div className="ball-left">
        <span className="ball-app">
          <span
            className="ball-status"
            style={{ background: summary.color }}
            title={`${summary.usageValue}${summary.usageUnit ? ` ${summary.usageUnit}` : ""}`}
          />
          <AppIcon size={10} />
          <span className="ball-app-text">{summary.app}</span>
        </span>
        <span className="ball-model">
          {summary.provider && (
            <span className="ball-tag ball-tag-provider">
              {summary.provider}
            </span>
          )}
          {summary.model && (
            <span className="ball-tag ball-tag-model">{summary.model}</span>
          )}
          {!summary.provider && !summary.model && <span>—</span>}
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
