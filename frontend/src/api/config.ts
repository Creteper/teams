/**
 * VITE_USE_MOCK：默认 true（未设置也走 mock）；设为 "false" 走真实后端（docs/api.md）。
 * VITE_API_BASE_URL：默认空串 = 同源，dev 下由 Vite 把 /api 代理到 127.0.0.1:8090。
 * VITE_WS_URL：默认按当前页面地址推导 ws(s)://<host>/api/v1/ws。
 */
export const USE_MOCK = (import.meta.env.VITE_USE_MOCK ?? "true") !== "false";
export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "";
export const API_PREFIX = "/api/v1";

export function wsUrl(): string {
  if (import.meta.env.VITE_WS_URL) return import.meta.env.VITE_WS_URL;
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}${API_PREFIX}/ws`;
}
