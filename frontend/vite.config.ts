import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// 开发端口 5190（3000 被其他服务占用；5173、5180 已被本机其他 vite 占用），strictPort 防止静默换端口。
// /api（含 WebSocket /api/v1/ws）代理到后端 127.0.0.1:8090（docs/api.md §0）。
const BACKEND = "http://127.0.0.1:8090";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5190,
    strictPort: true,
    proxy: {
      "/api": { target: BACKEND, changeOrigin: true, ws: true },
    },
  },
  preview: {
    port: 5191,
    strictPort: true,
    proxy: {
      "/api": { target: BACKEND, changeOrigin: true, ws: true },
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
