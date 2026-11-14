/**
 * VITE_USE_MOCK：显式 "false" 走真实后端，其它非空值走 mock；
 *   未设置时：dev（pnpm dev）默认走 mock，生产构建（pnpm build）默认走真实后端。
 *   该表达式在构建期被 Vite 静态替换为常量，生产包里 mock 分支会被整体摇掉。
 * VITE_API_BASE_URL：默认空串 = 同源相对路径 /api（dev 下 Vite 代理到 127.0.0.1:8090；生产由反代转发）。
 * VITE_WS_URL：默认按 location 推导（https → wss://<host>/api/v1/ws）。
 */
export const USE_MOCK: boolean = import.meta.env.VITE_USE_MOCK
  ? import.meta.env.VITE_USE_MOCK !== "false"
  : import.meta.env.DEV;
export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "";
export const API_PREFIX = "/api/v1";

export function wsUrl(): string {
  if (import.meta.env.VITE_WS_URL) return import.meta.env.VITE_WS_URL;
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}${API_PREFIX}/ws`;
}
