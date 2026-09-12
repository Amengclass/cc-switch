import { createPortal } from "react-dom";
import { Toaster as SonnerToaster } from "sonner";
import { useTheme } from "@/components/theme-provider";

/**
 * Sonner 提示容器。
 *
 * 通过 Portal 挂到 document.body 顶层：Sonner 默认就地渲染，若应用内有
 * 任意祖先创建 stacking context（position+z-index / transform / filter 等），
 * toast 的高 z-index 会被困在那一层之下，导致被 Dialog/Sheet 遮罩盖住而点不到
 * 关闭按钮。Portaling 到 body 顶层 + 内联 z-index 兜底，确保 toast 永远浮在所有
 * 浮层之上。
 *
 * 关键：Radix 模态 Dialog（如远程主机抽屉）打开时会设置 body 的
 * `pointer-events: none` 以禁用模态外交互。该值会传播到 body 所有后代，
 * 若 toast 容器不显式设回 `pointer-events: auto`，即使 z-index 再高也会被连带
 * 禁用点击。因此这里必须显式声明 pointerEvents: "auto"。
 */
export function Toaster() {
  const { theme } = useTheme();

  // 将应用主题映射到 Sonner 的主题
  // 如果是 "system"，Sonner 会自己处理
  const sonnerTheme = theme === "system" ? "system" : theme;

  return createPortal(
    <SonnerToaster
      position="top-center"
      richColors
      theme={sonnerTheme}
      closeButton
      style={{ zIndex: 999999999, pointerEvents: "auto" }}
      toastOptions={{
        duration: 2000,
        classNames: {
          toast:
            "group rounded-md border bg-background text-foreground shadow-lg",
          title: "text-sm font-semibold",
          description: "text-sm text-muted-foreground",
          actionButton:
            "rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90",
        },
      }}
    />,
    document.body,
  );
}
