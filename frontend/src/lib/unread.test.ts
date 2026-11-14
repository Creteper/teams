import { describe, expect, it } from "vitest";
import type { Channel, ChannelUserState, Message } from "../api/types";
import {
  applyState,
  countsAsUnread,
  markReadLocal,
  mergeUnreadSummary,
  onMessageCreated,
  removeTeam,
  seedTeam,
  sortChannels,
  teamSummary,
  unreadLabel,
  type UnreadMap,
} from "./unread";

const ch = (id: string, team_id = "t", extra: Partial<Channel> = {}) =>
  ({ id, team_id, name: id, topic: "", is_default: false, created_by_member_id: "x", last_message_seq: 10, created_at: "", ...extra }) as Channel;
const st = (channel_id: string, extra: Partial<ChannelUserState> = {}): ChannelUserState => ({
  channel_id,
  team_id: "t",
  pinned: false,
  pinned_at: null,
  last_read_seq: 5,
  unread_count: 0,
  has_unread_mention: false,
  ...extra,
});
const msg = (extra: Partial<Message> = {}) =>
  ({
    id: "m",
    seq: 6,
    team_id: "t",
    channel_id: "c",
    kind: "message",
    sender: { member_id: "other", type: "user", display_name: "O", avatar_url: null },
    content: "hi",
    mentions: [],
    attachments: [],
    reply_to: null,
    trigger_depth: 0,
    created_at: "",
    edited_at: null,
    deleted: false,
    ...extra,
  }) as Message;

describe("unreadLabel", () => {
  it("0 不显示；上限 1000 → 999+", () => {
    expect(unreadLabel(0)).toBeNull();
    expect(unreadLabel(1)).toBe("1");
    expect(unreadLabel(999)).toBe("999");
    expect(unreadLabel(1000)).toBe("999+");
  });
});

describe("本地累加（message.created）", () => {
  const map: UnreadMap = { c: st("c") };
  it("别的频道 +1，@ 我标记 mention", () => {
    const a = onMessageCreated(map, msg(), { myMemberId: "me" });
    expect(a.c).toMatchObject({ unread_count: 1, has_unread_mention: false });
    const b = onMessageCreated(a, msg({ seq: 7, mentions: [{ member_id: "me", type: "user", display_name: "Me" }] }), { myMemberId: "me" });
    expect(b.c).toMatchObject({ unread_count: 2, has_unread_mention: true });
  });
  it("自己发的、bot_declined、已删除、正在看的频道、seq ≤ 已读位置都不算", () => {
    expect(countsAsUnread(msg({ sender: { member_id: "me", type: "user", display_name: "Me", avatar_url: null, avatar_shape: null, avatar_color: null } }), "me")).toBe(false);
    expect(countsAsUnread(msg({ kind: "bot_declined" }), "me")).toBe(false);
    expect(countsAsUnread(msg({ deleted: true }), "me")).toBe(false);
    expect(onMessageCreated(map, msg(), { myMemberId: "me", viewingChannelId: "c" })).toBe(map);
    expect(onMessageCreated(map, msg({ seq: 5 }), { myMemberId: "me" })).toBe(map);
  });
  it("封顶 1000", () => {
    const full: UnreadMap = { c: st("c", { unread_count: 1000 }) };
    expect(onMessageCreated(full, msg(), { myMemberId: "me" }).c.unread_count).toBe(1000);
  });
  it("未知频道（例如别的 team）也会建条目", () => {
    expect(onMessageCreated({}, msg({ channel_id: "z", team_id: "t2" }), { myMemberId: "me" }).z).toMatchObject({ team_id: "t2", unread_count: 1 });
  });
});

describe("已读 / 服务端状态", () => {
  it("markReadLocal 清零且已读位置只前进", () => {
    const m = { c: st("c", { unread_count: 3, has_unread_mention: true, last_read_seq: 8 }) };
    expect(markReadLocal(m, "c", 6).c).toMatchObject({ unread_count: 0, has_unread_mention: false, last_read_seq: 8 });
    expect(markReadLocal(m, "c", 12).c.last_read_seq).toBe(12);
  });
  it("applyState 覆盖；seedTeam 用频道列表重置该 team；removeTeam", () => {
    let m: UnreadMap = { c: st("c"), x: st("x", { team_id: "t2", unread_count: 2 }) };
    m = applyState(m, st("c", { pinned: true, pinned_at: "2026-11-15T00:00:00Z" }));
    expect(m.c.pinned).toBe(true);
    m = seedTeam(m, "t", [ch("d", "t", { unread_count: 4, has_unread_mention: true })]);
    expect(Object.keys(m).sort()).toEqual(["d", "x"]);
    expect(m.d).toMatchObject({ unread_count: 4, has_unread_mention: true, pinned: false });
    expect(Object.keys(removeTeam(m, "t2"))).toEqual(["d"]);
  });
  it("mergeUnreadSummary：返回的覆盖；其他 team 没列出的清零；当前 team 不动", () => {
    const m: UnreadMap = { a: st("a", { team_id: "t2", unread_count: 3 }), b: st("b", { team_id: "t", unread_count: 1 }) };
    const next = mergeUnreadSummary(m, [st("c", { team_id: "t3", unread_count: 2, has_unread_mention: true })], "t");
    expect(next.a.unread_count).toBe(0);
    expect(next.b.unread_count).toBe(1);
    expect(next.c).toMatchObject({ unread_count: 2, has_unread_mention: true });
  });
  it("teamSummary 按 team 汇总（不含正在看的频道），@ 优先", () => {
    const m: UnreadMap = {
      a: st("a", { team_id: "t2", unread_count: 3 }),
      b: st("b", { team_id: "t2", unread_count: 1, has_unread_mention: true }),
      c: st("c", { team_id: "t", unread_count: 9 }),
    };
    expect(teamSummary(m, "c")).toEqual({ t2: { count: 4, mention: true } });
  });
});

describe("置顶排序", () => {
  it("置顶的单独成组，按 pinned_at 升序；其余保持后端顺序", () => {
    const list = [ch("g", "t", { is_default: true }), ch("a"), ch("b"), ch("c")];
    const m: UnreadMap = {
      c: st("c", { pinned: true, pinned_at: "2026-11-15T02:00:00Z" }),
      a: st("a", { pinned: true, pinned_at: "2026-11-15T01:00:00Z" }),
    };
    const r = sortChannels(list, m);
    expect(r.pinned.map((c) => c.id)).toEqual(["a", "c"]);
    expect(r.others.map((c) => c.id)).toEqual(["g", "b"]);
  });
});
