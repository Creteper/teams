import { describe, expect, it } from "vitest";
import type { Message } from "../api/types";
import { groupMessages, mergeMessages } from "./messages";

const mk = (id: string, seq: number, sender: string, minute: number): Message => ({
  id,
  seq,
  team_id: "t",
  channel_id: "c",
  sender: { member_id: sender, type: "user", display_name: sender },
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
