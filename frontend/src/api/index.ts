import type { RealtimeClient, TeamsApi } from "./client";
import { createHttpApi } from "./http/httpApi";
import { createWsRealtime } from "./http/wsRealtime";

export type { TeamsApi, RealtimeClient, FrameHandler } from "./client";
export { fetchAllMembers } from "./client";
export * from "./types";
export { ApiError } from "./errors";

/**
 * 条件直接写在这里（而不是引用 config.USE_MOCK），让构建期常量折叠后整条 mock 分支连同动态 import 被删除：
 * 生产构建未设置 VITE_USE_MOCK 时，dist 里不会出现 mock 代码和数据。
 */
const built: { api: TeamsApi; realtime: RealtimeClient } = (
  import.meta.env.VITE_USE_MOCK ? import.meta.env.VITE_USE_MOCK !== "false" : import.meta.env.DEV
)
  ? (await import("./mock")).createMockImpl()
  : { api: createHttpApi(), realtime: createWsRealtime() };

/** 全局单例：页面统一从这里拿 api / realtime（VITE_USE_MOCK 切换实现） */
export const api: TeamsApi = built.api;
export const realtime: RealtimeClient = built.realtime;
