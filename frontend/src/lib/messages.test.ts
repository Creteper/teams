import { describe, expect, it } from "vitest";
import type { Message } from "../api/types";
import { attachDeclines, groupMessages, mergeMessages } from "./messages";

const mk = (id: string, seq: number, sender: string, minute: number): Message => ({
  id,
  seq,
  team_id: "t",
  channel_id: "c",
  sender: { member_id: sender, type: "user", display_name: sender, avatar_url: null, avatar_shape: null, avatar_color: null },
  content: id,
  mentions: [],
  attachments: [],
  reply_to: null,
  trigger_depth: 0,
  created_at: new Date(Date.UTC(2026, 10, 14, 12, minute)).toISOString(),
  edited_at: null,
  deleted: false,
});

describe("groupMessages", () => {
  it("同一发送者 5 分钟内合并", () => {
    const groups = groupMessages([mk("1", 1, "a", 0), mk("2", 2, "a", 3), mk("3", 3, "b", 4), mk("4", 4, "b", 20)]);
    expect(groups.map((g) => g.map((m) => m.id))).toEqual([["1", "2"], ["3"], ["4"]]);
  });
});

describe("mergeMessages", () => {
  it("按 seq 去重并排序", () => {
    const merged = mergeMessages([mk("1", 1, "a", 0), mk("3", 3, "a", 0)], [mk("2", 2, "a", 0), mk("3", 3, "a", 1)]);
    expect(merged.map((m) => m.seq)).toEqual([1, 2, 3]);
  });
});

describe("bot_declined 挂到触发消息下面", () => {
  const base = (id: string, extra: Partial<Message> = {}) =>
    ({
      id,
      seq: 1,
      team_id: "t",
      channel_id: "c",
      kind: "message",
      sender: { member_id: "a", type: "user", display_name: "A", avatar_url: null, avatar_shape: null, avatar_color: null },
      content: "",
      mentions: [],
      attachments: [],
      reply_to: null,
      trigger_depth: 0,
      created_at: new Date(0).toISOString(),
      edited_at: null,
      deleted: false,
      ...extra,
    }) as Message;
  it("触发消息已加载 → 进 byTrigger；没加载 → 留在 main", () => {
    const bot = { member_id: "b", type: "bot" as const, display_name: "Dean", avatar_url: null, avatar_shape: null, avatar_color: null };
    const list = [base("t1"), base("d1", { kind: "bot_declined", reply_to: "t1", sender: bot }), base("d2", { kind: "bot_declined", reply_to: "old", sender: bot })];
    const r = attachDeclines(list);
    expect(r.main.map((m) => m.id)).toEqual(["t1", "d2"]);
    expect(r.byTrigger.get("t1")?.map((m) => m.id)).toEqual(["d1"]);
    // 不回复提示不和同一 bot 的普通消息合并成一组
    const g = groupMessages([base("x", { sender: bot }), base("d3", { kind: "bot_declined", sender: bot })]);
    expect(g).toHaveLength(2);
  });
});
