import { describe, expect, it } from "vitest";
import type { Message } from "../api/types";
import { emptySendState, matchOutbox, outboxAsMessage, sendReducer, type OutboxItem, type SendState } from "./outbox";

const me = { member_id: "me", type: "user" as const, display_name: "Me", avatar_url: null, avatar_shape: null, avatar_color: null };
const item = (local_id: string, content = "hi", extra: Partial<OutboxItem> = {}): OutboxItem => ({
  local_id,
  channel_id: "c",
  content,
  attachments: [],
  client_msg_id: `c-${local_id}`,
  status: "sending",
  created_at: "2026-11-15T00:00:00Z",
  sender: me,
  bot_member_ids: [],
  ...extra,
});
const msg = (id: string, content = "hi", extra: Partial<Message> = {}): Message => ({
  id,
  seq: 10,
  kind: "message",
  team_id: "t",
  channel_id: "c",
  sender: me,
  content,
  mentions: [],
  attachments: [],
  reply_to: null,
  trigger_depth: 0,
  created_at: "2026-11-15T00:00:01Z",
  edited_at: null,
  deleted: false,
  ...extra,
});
const run = (...actions: Parameters<typeof sendReducer>[1][]): SendState => actions.reduce(sendReducer, emptySendState);

describe("乐观发送 sendReducer", () => {
  it("HTTP 先到：移出 outbox，真实 id → 本地 key；随后 WebSocket 推送不再改动", () => {
    const s = run({ type: "enqueue", item: item("L1") }, { type: "sent", local_id: "L1", message: msg("m1") });
    expect(s.outbox).toEqual([]);
    expect(s.keyOf).toEqual({ m1: "L1" });
    expect(sendReducer(s, { type: "echo", message: msg("m1"), myMemberId: "me" })).toBe(s);
  });
  it("WebSocket 先到：按内容认领；随后 HTTP 响应不重复、不换 key", () => {
    const s = run({ type: "enqueue", item: item("L1") }, { type: "echo", message: msg("m1"), myMemberId: "me" });
    expect(s.outbox).toEqual([]);
    expect(s.keyOf).toEqual({ m1: "L1" });
    expect(sendReducer(s, { type: "sent", local_id: "L1", message: msg("m1") })).toBe(s);
  });
  it("WebSocket 先到后 HTTP 才报错（例如超时）：已确认，忽略失败", () => {
    const s = run({ type: "enqueue", item: item("L1") }, { type: "echo", message: msg("m1"), myMemberId: "me" });
    expect(sendReducer(s, { type: "failed", local_id: "L1", error: "timeout" })).toBe(s);
  });
  it("失败 → 重试仍是原来那条（同一个 local_id、client_msg_id）→ 成功", () => {
    let s = run({ type: "enqueue", item: item("L1") }, { type: "failed", local_id: "L1", error: "网络异常" });
    expect(s.outbox[0]).toMatchObject({ local_id: "L1", status: "failed", error: "网络异常" });
    s = sendReducer(s, { type: "sending", local_id: "L1" });
    expect(s.outbox[0]).toMatchObject({ local_id: "L1", status: "sending", client_msg_id: "c-L1" });
    expect(s.outbox[0].error).toBeUndefined();
    s = sendReducer(s, { type: "sent", local_id: "L1", message: msg("m1") });
    expect(s).toEqual({ outbox: [], keyOf: { m1: "L1" } });
  });
  it("失败的条目也能被 WebSocket 认领（服务端其实已创建）", () => {
    const s = run({ type: "enqueue", item: item("L1") }, { type: "failed", local_id: "L1", error: "x" }, { type: "echo", message: msg("m1"), myMemberId: "me" });
    expect(s).toEqual({ outbox: [], keyOf: { m1: "L1" } });
  });
  it("删除失败的消息", () => {
    expect(run({ type: "enqueue", item: item("L1") }, { type: "discard", local_id: "L1" }).outbox).toEqual([]);
  });
  it("已按自己的 id 显示（WebSocket 先到但没匹配上）：HTTP 成功只移除 outbox，不改 key", () => {
    const s = run({ type: "enqueue", item: item("L1") }, { type: "sent", local_id: "L1", message: msg("m1"), alreadyShown: true });
    expect(s).toEqual({ outbox: [], keyOf: {} });
  });
  it("切频道只保留当前频道和失败的", () => {
    const s = run(
      { type: "enqueue", item: item("A", "a", { channel_id: "x" }) },
      { type: "enqueue", item: item("B", "b", { channel_id: "x", status: "failed" }) },
      { type: "enqueue", item: item("C", "c", { channel_id: "y" }) },
      { type: "leaveChannel", channel_id: "y" },
    );
    expect(s.outbox.map((o) => o.local_id)).toEqual(["B", "C"]);
  });
});

describe("matchOutbox", () => {
  const box = [item("L1", "ok"), item("L2", "ok"), item("L3", "带图", { attachments: [{ id: "a1" } as never] })];
  it("同发送者、同频道、同正文、同附件；多条相同取最早的", () => {
    expect(matchOutbox(box, msg("m", "ok"), "me")?.local_id).toBe("L1");
    expect(matchOutbox(box, msg("m", "带图", { attachments: [{ id: "a1" } as never] }), "me")?.local_id).toBe("L3");
    expect(matchOutbox(box, msg("m", "带图"), "me")).toBeUndefined();
  });
  it("别人发的、别的频道、bot_declined 不匹配", () => {
    expect(matchOutbox(box, msg("m", "ok", { sender: { ...me, member_id: "bob" } }), "me")).toBeUndefined();
    expect(matchOutbox(box, msg("m", "ok", { channel_id: "z" }), "me")).toBeUndefined();
    expect(matchOutbox(box, msg("m", "ok", { kind: "bot_declined" }), "me")).toBeUndefined();
  });
  it("伪消息排在所有真实消息之后", () => {
    expect(outboxAsMessage(item("L1")).seq).toBe(Number.POSITIVE_INFINITY);
  });
});
