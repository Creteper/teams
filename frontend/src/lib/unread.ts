import type { Channel, ChannelUserState, Message, Team } from "../api/types";

/**
 * 未读与置顶（docs/api.md §5.7）——纯函数，便于测试。
 *
 * 状态按 channel_id 存：进入 team 时用频道列表的字段初始化，GET /me/unread 补上其他 team 的；
 * message.created 本地累加，channel.read / channel.pinned 直接覆盖。
 */

export const UNREAD_CAP = 1000;

export type UnreadMap = Record<string, ChannelUserState>;

/** 徽标文字：0 不显示；到上限（≥1000）显示 999+ */
export function unreadLabel(n: number): string | null {
  if (!n || n <= 0) return null;
  return n >= UNREAD_CAP ? "999+" : String(n);
}

/** 频道对象里的本人状态 → ChannelUserState（字段缺省按“已读、未置顶”处理） */
export function stateOfChannel(c: Channel): ChannelUserState {
  return {
    channel_id: c.id,
    team_id: c.team_id,
    pinned: !!c.pinned,
    pinned_at: c.pinned_at ?? null,
    last_read_seq: c.last_read_seq ?? 0,
    unread_count: c.unread_count ?? 0,
    has_unread_mention: !!c.has_unread_mention,
  };
}

/** 用一个 team 的频道列表重置该 team 的状态（列表里没有的频道视为已删除，移除） */
export function seedTeam(map: UnreadMap, teamId: string, channels: Channel[]): UnreadMap {
  const next: UnreadMap = {};
  for (const [id, st] of Object.entries(map)) if (st.team_id !== teamId) next[id] = st;
  for (const c of channels) if (c.team_id === teamId) next[c.id] = stateOfChannel(c);
  return next;
}

/** GET /me/unread：覆盖返回的频道；本地已知、但不在结果里的其他 team 频道说明已经没有未读 */
export function mergeUnreadSummary(map: UnreadMap, items: ChannelUserState[], exceptTeamId?: string): UnreadMap {
  const next: UnreadMap = { ...map };
  const listed = new Set(items.map((i) => i.channel_id));
  for (const [id, st] of Object.entries(next)) {
    if (st.team_id === exceptTeamId || listed.has(id)) continue;
    if (st.unread_count || st.has_unread_mention) next[id] = { ...st, unread_count: 0, has_unread_mention: false };
  }
  for (const it of items) if (it.team_id !== exceptTeamId) next[it.channel_id] = { ...next[it.channel_id], ...it };
  return next;
}

/** channel.read / channel.pinned / 接口响应：直接覆盖 */
export function applyState(map: UnreadMap, st: ChannelUserState): UnreadMap {
  return { ...map, [st.channel_id]: { ...map[st.channel_id], ...st } };
}

/** 这条新消息该不该算未读：普通消息、未删除、不是自己发的（§5.7） */
export function countsAsUnread(m: Message, myMemberId: string | undefined): boolean {
  if ((m.kind ?? "message") !== "message") return false;
  if (m.deleted) return false;
  if (myMemberId && m.sender.member_id === myMemberId) return false;
  return true;
}

/**
 * message.created 本地累加：不是正在看的频道才 +1（封顶 1000），@ 我则 has_unread_mention = true。
 * seq 不大于已读位置的（重复推送 / 补拉）不算。
 */
export function onMessageCreated(map: UnreadMap, m: Message, opts: { myMemberId?: string; viewingChannelId?: string }): UnreadMap {
  if (!countsAsUnread(m, opts.myMemberId)) return map;
  if (m.channel_id === opts.viewingChannelId) return map;
  const prev: ChannelUserState = map[m.channel_id] ?? {
    channel_id: m.channel_id,
    team_id: m.team_id,
    pinned: false,
    pinned_at: null,
    last_read_seq: 0,
    unread_count: 0,
    has_unread_mention: false,
  };
  if (m.seq <= prev.last_read_seq) return map;
  const mentionsMe = !!opts.myMemberId && m.mentions.some((x) => x.member_id === opts.myMemberId);
  return {
    ...map,
    [m.channel_id]: {
      ...prev,
      unread_count: Math.min(UNREAD_CAP, prev.unread_count + 1),
      has_unread_mention: prev.has_unread_mention || mentionsMe,
    },
  };
}

/** 打开 / 正在看：本地先清零（乐观），再用接口响应覆盖；已读位置只前进 */
export function markReadLocal(map: UnreadMap, channelId: string, seq?: number): UnreadMap {
  const prev = map[channelId];
  if (!prev) return map;
  return {
    ...map,
    [channelId]: { ...prev, last_read_seq: Math.max(prev.last_read_seq, seq ?? prev.last_read_seq), unread_count: 0, has_unread_mention: false },
  };
}

export function removeChannel(map: UnreadMap, channelId: string): UnreadMap {
  if (!map[channelId]) return map;
  const next = { ...map };
  delete next[channelId];
  return next;
}

export function removeTeam(map: UnreadMap, teamId: string): UnreadMap {
  const next: UnreadMap = {};
  for (const [id, st] of Object.entries(map)) if (st.team_id !== teamId) next[id] = st;
  return next;
}

export interface TeamUnread {
  count: number;
  mention: boolean;
}

/** team 图标上的汇总（不含正在看的频道） */
export function teamSummary(map: UnreadMap, viewingChannelId?: string): Record<string, TeamUnread> {
  const out: Record<string, TeamUnread> = {};
  for (const st of Object.values(map)) {
    if (st.channel_id === viewingChannelId) continue;
    if (!st.unread_count && !st.has_unread_mention) continue;
    const t = (out[st.team_id] ??= { count: 0, mention: false });
    t.count = Math.min(UNREAD_CAP, t.count + st.unread_count);
    t.mention ||= st.has_unread_mention;
  }
  return out;
}

/**
 * 频道排序：后端顺序不变（默认频道在前，再按创建时间），置顶的按 pinned_at 排到最前面。
 * 置顶频道之间按 pinned_at 升序（先置顶的在上；文档没规定，见汇报）。
 */
export function sortChannels(channels: Channel[], map: UnreadMap): { pinned: Channel[]; others: Channel[] } {
  const pinned: Channel[] = [];
  const others: Channel[] = [];
  for (const c of channels) (map[c.id]?.pinned ? pinned : others).push(c);
  const at = (c: Channel) => Date.parse(map[c.id]?.pinned_at ?? "") || 0;
  pinned.sort((a, b) => at(a) - at(b));
  return { pinned, others };
}

/** 我在各 team 的 member_id（判断“自己发的”“@ 我”） */
export function myMemberIds(teams: Team[]): Record<string, string> {
  return Object.fromEntries(teams.map((t) => [t.id, t.my_member_id]));
}
