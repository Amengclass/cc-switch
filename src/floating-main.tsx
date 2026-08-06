import React, { useEffect } from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { FloatingBall } from "./floating/FloatingBall";
import { FloatingPanel } from "./floating/FloatingPanel";
import "./floating/floating.css";

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
function FloatingApp() {
  const label = getCurrentWindow().label;
  return (
    <>
      <FloatingThemeSync />
      {label === "floating-ball" ? (
        <FloatingBall />
      ) : label === "floating-panel" ? (
        <FloatingPanel />
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
