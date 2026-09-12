import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { codeInspectorPlugin } from "code-inspector-plugin";

export default defineConfig(({ command }) => ({
  root: "src",
  plugins: [
    command === "serve" &&
      codeInspectorPlugin({
        bundler: "vite",
      }),
    react(),
  ].filter(Boolean),
  base: "./",
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    // 多页入口：主应用 + 悬浮窗（加速球）独立 HTML，
    // 让悬浮窗窗口只加载悬浮球/面板组件，彻底避免路由分派到主 App。
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, "src/index.html"),
        floating: path.resolve(__dirname, "src/floating.html"),
      },
    },
  },
  server: {
    port: 3000,
    strictPort: true,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  clearScreen: false,
  envPrefix: ["VITE_", "TAURI_"],
}));

