import type { RealtimeClient, TeamsApi } from "./client";
import { USE_MOCK } from "./config";
import { createHttpApi } from "./http/httpApi";
import { createWsRealtime } from "./http/wsRealtime";
import { createMockDb } from "./mock/db";
import { createMockApi } from "./mock/mockApi";
import { createMockRealtime } from "./mock/mockRealtime";

export type { TeamsApi, RealtimeClient, FrameHandler } from "./client";
export { fetchAllMembers } from "./client";
export * from "./types";
export { ApiError } from "./errors";

function build(): { api: TeamsApi; realtime: RealtimeClient } {
  if (USE_MOCK) {
    const db = createMockDb();
    return { api: createMockApi(db), realtime: createMockRealtime(db) };
  }
  return { api: createHttpApi(), realtime: createWsRealtime() };
}

const built = build();

/** 全局单例：页面统一从这里拿 api / realtime（VITE_USE_MOCK 切换实现） */
export const api: TeamsApi = built.api;
export const realtime: RealtimeClient = built.realtime;
