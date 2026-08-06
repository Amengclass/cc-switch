import { useCallback, useEffect, useState } from "react";
import type { PointerEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { statusColor, type FloatingEntry } from "./types";

async function loadWorstPct(): Promise<{ worst: number | null; glyph: string }> {
  const entries = (await invoke("get_floating_window_data")) as FloatingEntry[];
  const pcts = entries
    .map((e) => e.worstPct)
    .filter((p): p is number => p != null);
  const worst = pcts.length ? Math.max(...pcts) : null;
  // 球中央显示用量最差的 app 缩写，否则显示 "CC"
  const ranked = [...entries]
    .filter((e) => e.worstPct != null)
    .sort((a, b) => (b.worstPct ?? 0) - (a.worstPct ?? 0));
  const glyph = ranked[0] ? ranked[0].appLabel.slice(0, 2) : "CC";
  return { worst, glyph };
}

/**
 * 悬浮球（64×64 透明窗）：
 * - 拖动：按下/松开只发信号给 Rust，Rust 用 GetCursorPos 轮询全局光标 + set_position
 *   移动窗口（绕开 WebView 事件），松手自动吸附，无位移即单击→打开主窗口
 * - 悬停展开面板，离开时通知后端宽限隐藏
 */
export function FloatingBall() {
  const [worst, setWorst] = useState<number | null>(null);
  const [glyph, setGlyph] = useState("CC");

  const refresh = useCallback(() => {
    loadWorstPct()
      .then(({ worst, glyph }) => {
        setWorst(worst);
        setGlyph(glyph);
      })
      .catch((e) => console.error("[Floating] 刷新数据失败", e));
  }, []);

  useEffect(() => {
    refresh();
    const unlisteners: Array<() => void> = [];
    void listen("floating-data-refresh", refresh).then((u) => unlisteners.push(u));
    void listen("provider-switched", refresh).then((u) => unlisteners.push(u));
    void listen("usage-cache-updated", refresh).then((u) => unlisteners.push(u));
    const timer = setInterval(refresh, 5_000);
    return () => {
      clearInterval(timer);
      unlisteners.forEach((u) => u());
    };
  }, [refresh]);

  const color = statusColor(worst);

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
      onMouseEnter={() => void invoke("show_floating_panel")}
      onMouseLeave={() =>
        void invoke("floating_set_hover", { source: "ball", active: false })
      }
    >
      <div className="ball-inner" style={{ borderColor: color }}>
        <span className="ball-glyph">{glyph}</span>
      </div>
    </div>
  );
}
