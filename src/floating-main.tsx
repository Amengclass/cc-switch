import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { FloatingBall } from "./floating/FloatingBall";
import { FloatingPanel } from "./floating/FloatingPanel";
import { FloatingContextMenu } from "./floating/FloatingContextMenu";
import "./floating/floating.css";
// 悬浮窗是独立入口（floating.html），需自行初始化 i18n，否则 useTranslation() 读不到 key 会显示 key 名。
import "./i18n";

const THEME_STORAGE_KEY = "cc-switch-theme";

/**
 * 与主应用共享外观主题（localStorage 同源共享）：
 * - 读取 `cc-switch-theme`（light / dark / system），在悬浮窗 html 上打 light/dark 类
 * - 主窗口改主题会触发本窗口的 `storage` 事件 → 立即同步（无需重启）
 * - system 模式下监听系统深浅色变化
 * - 同步原生窗口主题，保证 matchMedia 跟随 OS
 */
function FloatingThemeSync() {
  useEffect(() => {
    const apply = () => {
      const root = document.documentElement;
      root.classList.remove("light", "dark");

      let theme: string | null = "system";
      try {
        const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
        if (stored === "light" || stored === "dark" || stored === "system") {
          theme = stored;
        }
      } catch {
        // localStorage 不可用时默认跟随系统
      }

      let isDark = false;
      if (theme === "dark") {
        isDark = true;
      } else if (theme === "system") {
        isDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      }
      root.classList.add(isDark ? "dark" : "light");

      void invoke("set_window_theme", { theme }).catch(() => {});
    };

    apply();

    // 主窗口切换主题时 localStorage 变更会在其他同源窗口触发 storage 事件
    window.addEventListener("storage", apply);
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", apply);
    return () => {
      window.removeEventListener("storage", apply);
      mq.removeEventListener("change", apply);
    };
  }, []);

  return null;
}

/**
 * 悬浮窗独立入口。与主应用（main.tsx → App）完全分离，
 * 后端用 `WebviewUrl::App("floating.html")` 加载本页，
 * 再按窗口 label 分派渲染小球或面板组件。
 */

/**
 * 窗口级 hover 覆盖层：占满整个透明窗口（含四周 FLOATING_MARGIN 留白）。
 * hover 判定绑在窗口层而非内容元素（.ball/.panel）上——否则鼠标移到球/面板
 * 边缘的透明留白区（视觉上仍在悬浮窗内）就会触发 mouseleave，面板随即消失。
 * 球窗口 192×52 vs 球内容 180×40、面板窗口 312×332 vs 面板内容 300×320。
 */
function FloatingHoverLayer({
  source,
  onEnter,
  children,
}: {
  source: "ball" | "panel";
  onEnter?: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className="floating-hover-layer"
      onMouseEnter={() => {
        void invoke("floating_set_hover", { source, active: true });
        onEnter?.();
      }}
      onMouseLeave={() =>
        void invoke("floating_set_hover", { source, active: false })
      }
    >
      {children}
    </div>
  );
}

/**
 * 收起后的色条：白色半透明条 + 用量颜色指示器。
 * 窗口尺寸由 Rust collapse_ball 按边缘方向设置（左/右=窄竖条，上/下=宽横条），
 * React 只需填满窗口并显示颜色指示。
 */
function FloatingStrip() {
  const [color, setColor] = useState("#94a3b8");
  const [opacity, setOpacity] = useState(0.92);

  useEffect(() => {
    let alive = true;
    // 从后端读取当前用量颜色
    void invoke("get_floating_ball_detail").then((entry: any) => {
      if (!alive || !entry) return;
      // 复用球的颜色等级逻辑
      let level = "good";
      if (entry.usage && entry.usage.length > 0) {
        for (const u of entry.usage) {
          if (u.isValid === false) { level = "danger"; break; }
          if (u.used != null && u.used >= 90) { level = "warn"; }
        }
      }
      const colorMap: Record<string, string> = {
        danger: "#ef4444", warn: "#f97316", good: "#16a3b8",
      };
      setColor(colorMap[level] ?? "#94a3b8");
    }).catch(() => {});
    void invoke("get_settings").then((s: any) => {
      if (alive && s?.floatingOpacity != null) setOpacity(s.floatingOpacity);
    }).catch(() => {});
    // 定时刷新颜色
    const timer = setInterval(() => {
      void invoke("get_floating_ball_detail").then((entry: any) => {
        if (!alive || !entry) return;
        let level = "good";
        if (entry.usage && entry.usage.length > 0) {
          for (const u of entry.usage) {
            if (u.isValid === false) { level = "danger"; break; }
            if (u.used != null && u.used >= 90) { level = "warn"; }
          }
        }
        const colorMap: Record<string, string> = {
          danger: "#ef4444", warn: "#f97316", good: "#16a34a",
        };
        setColor(colorMap[level] ?? "#94a3b8");
      }).catch(() => {});
    }, 2000);
    return () => { alive = false; clearInterval(timer); };
  }, []);

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        background: `rgba(255,255,255,${opacity})`,
        borderRadius: 4,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        boxShadow: "0 1px 4px rgba(0,0,0,0.15)",
        cursor: "pointer",
      }}
      onClick={() => void invoke("floating_expand_from_strip")}
    >
      <div
        style={{
          width: "60%",
          height: "40%",
          minWidth: 3,
          minHeight: 3,
          maxWidth: 20,
          maxHeight: 20,
          background: color,
          borderRadius: 2,
        }}
      />
    </div>
  );
}

function FloatingApp() {
  const label = getCurrentWindow().label;
  return (
    <>
      <FloatingThemeSync />
      {label === "floating-ball" ? (
        <FloatingHoverLayer
          source="ball"
          onEnter={() => void invoke("show_floating_panel")}
        >
          <FloatingBall />
        </FloatingHoverLayer>
      ) : label === "floating-panel" ? (
        <FloatingHoverLayer source="panel">
          <FloatingPanel />
        </FloatingHoverLayer>
      ) : label === "floating-menu" ? (
        <FloatingContextMenu />
      ) : label === "floating-strip" ? (
        <FloatingStrip />
      ) : (
        <div style={{ color: "#fff", padding: 8 }}>unknown window: {label}</div>
      )}
    </>
  );
}

ReactDOM.createRoot(document.getElementById("floating-root")!).render(
  <React.StrictMode>
    <FloatingApp />
  </React.StrictMode>,
);
