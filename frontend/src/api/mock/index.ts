import type { RealtimeClient, TeamsApi } from "../client";
import { createMockDb } from "./db";
import { createMockApi } from "./mockApi";
import { createMockRealtime } from "./mockRealtime";

/** mock 实现入口：只通过 api/index.ts 的条件动态 import 加载，生产构建默认不打包 */
export function createMockImpl(): { api: TeamsApi; realtime: RealtimeClient } {
  const db = createMockDb();
  return { api: createMockApi(db), realtime: createMockRealtime(db) };
}
