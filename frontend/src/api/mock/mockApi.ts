import { mockIssues } from "./issues";
import type { TeamsApi } from "../client";
import { ApiError } from "../errors";
import type { Attachment, AuthResponse, Channel, ChannelUserState, Invite, Member, Message, Page, Team, User } from "../types";
import { AVATAR_MAX_BYTES, AVATAR_MAX_DIM, AVATAR_TYPES, gifSize, sniffImage } from "../../lib/avatarCrop";
import { inviteStatus } from "../../lib/invite";
import { checkUpload } from "../../lib/upload";
import { emit, nextId, nextSeq, senderOf, type MockDb, type TeamRecord } from "./db";

/**
 * Mock 实现：内存数据 + 少量延迟，校验规则和错误码尽量贴近 docs/api.md。
 * 不保存、不校验密码（仅按文档做长度校验）；令牌是 mock 随机串。
 */

const USERNAME_RE = /^[a-z0-9_.-]{3,32}$/;
const CLIENT_MSG_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const all = <T,>(items: T[]): Page<T> => ({ items, next_cursor: null, has_more: false });

const inOneHour = () => new Date(Date.now() + 3600_000).toISOString();

export function createMockApi(db: MockDb, opts: { latencyMs?: number } = {}): TeamsApi {
  const latency = opts.latencyMs ?? 150;
  const delay = () => (latency > 0 ? new Promise<void>((r) => setTimeout(r, latency)) : Promise.resolve());
  const err = (status: number, code: string, message: string, details?: Record<string, unknown>) =>
    new ApiError(status, code, message, details, `req_mock_${Date.now().toString(36)}`);

  function issue(user: User): AuthResponse {
    // mock 令牌形如 tas_mock_<username>_<随机>，便于刷新页面后恢复会话（真实令牌由后端签发）
    const token = `tas_mock_${user.username}_${Math.random().toString(36).slice(2, 10)}`;
    db.sessions.set(token, user.id);
    return { user, token, expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString() };
  }

  function authed(token: string): User {
    let userId = db.sessions.get(token);
    if (!userId) {
      const m = /^tas_mock_([a-z0-9_.-]+)_[a-z0-9]+$/.exec(token);
      const u = m ? [...db.users.values()].find((x) => x.username === m[1]) : undefined;
      if (u) {
        userId = u.id;
        db.sessions.set(token, u.id);
      }
    }
    const user = userId ? db.users.get(userId) : undefined;
    if (!user) throw err(401, "unauthorized", "未登录或令牌无效");
    return user;
  }

  function myMember(user: User, teamId: string): Member | undefined {
    return db.members.find((m) => m.team_id === teamId && m.user_id === user.id);
  }

  function requireMember(user: User, teamId: string): Member {
    if (!db.teams.has(teamId)) throw err(404, "not_found", "Team 不存在");
    const me = myMember(user, teamId);
    if (!me) throw err(404, "not_found", "Team 不存在");
    return me;
  }

  function setMyAvatar(user: User, url: string | null): User {
    user.avatar_url = url;
    for (const m of db.members.filter((x) => x.user_id === user.id)) {
      m.avatar_url = url;
      emit(db, { type: "member.updated", team_id: m.team_id, data: { ...m } });
    }
    return { ...user };
  }

  // ---------- §5.7 未读与置顶（按用户） ----------
  const stKey = (userId: string, channelId: string) => `${userId}:${channelId}`;

  function userState(user: User, channel: Channel): ChannelUserState {
    const me = myMember(user, channel.team_id);
    const stored = db.channelState.get(stKey(user.id, channel.id));
    // 有效已读位置 = max(标记过的位置, 加入 team 时的 seq)
    const last = Math.max(stored?.last_read_seq ?? 0, me ? (db.joinSeq.get(me.id) ?? 0) : 0);
    let count = 0;
    let mention = false;
    for (const m of db.messages) {
      if (m.channel_id !== channel.id || m.seq <= last || m.deleted || (m.kind ?? "message") !== "message") continue;
      if (me && m.sender.member_id === me.id) continue;
      count += 1;
      if (me && m.mentions.some((x) => x.member_id === me.id)) mention = true;
    }
    return {
      channel_id: channel.id,
      team_id: channel.team_id,
      pinned: !!stored?.pinned_at,
      pinned_at: stored?.pinned_at ?? null,
      last_read_seq: last,
      unread_count: Math.min(1000, count),
      has_unread_mention: mention,
    };
  }

  /** 用户会话读取频道时带上本人状态 */
  function channelView(user: User, c: Channel): Channel {
    const st = userState(user, c);
    return { ...c, pinned: st.pinned, pinned_at: st.pinned_at, last_read_seq: st.last_read_seq, unread_count: st.unread_count, has_unread_mention: st.has_unread_mention };
  }

  function setReadPosition(user: User, channel: Channel, seq: number): ChannelUserState {
    const before = userState(user, channel);
    const k = stKey(user.id, channel.id);
    const stored = db.channelState.get(k) ?? { last_read_seq: 0, pinned_at: null };
    const target = Math.min(seq, channel.last_message_seq);
    if (target > before.last_read_seq) {
      db.channelState.set(k, { ...stored, last_read_seq: target });
      const after = userState(user, channel);
      emit(db, { type: "channel.read", team_id: channel.team_id, data: after }, { only: user.id });
      return after;
    }
    return before;
  }

  function userChannel(token: string, channelId: string): { user: User; channel: Channel } {
    const user = authed(token);
    const channel = db.channels.get(channelId);
    if (!channel) throw err(404, "not_found", "频道不存在");
    requireMember(user, channel.team_id);
    return { user, channel };
  }

  function setPin(token: string, channelId: string, pinned: boolean): ChannelUserState {
    const { user, channel } = userChannel(token, channelId);
    const k = stKey(user.id, channel.id);
    const stored = db.channelState.get(k) ?? { last_read_seq: 0, pinned_at: null };
    const changed = pinned ? !stored.pinned_at : !!stored.pinned_at;
    // 幂等：重复置顶保持原来的 pinned_at
    if (changed) db.channelState.set(k, { ...stored, pinned_at: pinned ? new Date().toISOString() : null });
    const st = userState(user, channel);
    if (changed) emit(db, { type: "channel.pinned", team_id: channel.team_id, data: st }, { only: user.id });
    return st;
  }

  function view(t: TeamRecord, me: Member): Team {
    return { ...t, my_member_id: me.id, my_role: me.role === "bot" ? "member" : me.role };
  }

  function addUserMember(teamId: string, u: User, role: Member["role"]): Member {
    const member: Member = {
      id: nextId(db),
      team_id: teamId,
      type: "user",
      user_id: u.id,
      bot_id: null,
      display_name: u.display_name,
      username: u.username,
      avatar_url: u.avatar_url,
      avatar_shape: null,
      avatar_color: null,
      description: null,
      role,
      joined_at: new Date().toISOString(),
    };
    db.members.push(member);
    // 加入 team 时之前的消息视为已读（§5.7 join_seq）
    db.joinSeq.set(member.id, db.seq);
    return member;
  }

  function requireManager(user: User, teamId: string): Member {
    const me = requireMember(user, teamId);
    if (me.role !== "owner" && me.role !== "admin") throw err(403, "forbidden", "只有 owner/admin 可以管理邀请");
    return me;
  }

  function findInvite(code: string): Invite {
    const invite = db.invites.find((i) => i.code === code);
    if (!invite) throw err(404, "invite_not_found", "邀请链接不存在");
    return invite;
  }

  const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  function newCode(): string {
    let code = "";
    do {
      code = Array.from({ length: 8 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join("");
    } while (db.invites.some((i) => i.code === code));
    return code;
  }

  return {
    ...mockIssues(db, token => authed(token).id, (token, teamId) => requireMember(authed(token), teamId)),
    async previewInvite(code) {
      await delay();
      const invite = findInvite(code);
      const team = db.teams.get(invite.team_id)!;
      const status = inviteStatus(invite);
      return {
        code: invite.code,
        team: {
          id: team.id,
          name: team.name,
          icon_url: team.icon_url,
          member_count: db.members.filter((m) => m.team_id === team.id).length,
        },
        expires_at: invite.expires_at,
        valid: status === "active",
        ...(status === "active" ? {} : { reason: status }),
      };
    },

    async acceptInvite(token, code) {
      await delay();
      const user = authed(token);
      const invite = findInvite(code);
      const team = db.teams.get(invite.team_id)!;
      const existing = myMember(user, team.id);
      if (existing) return { team: view(team, existing), member: existing, already_member: true };
      const status = inviteStatus(invite);
      if (status !== "active") {
        const text = { expired: "邀请链接已过期", revoked: "邀请链接已作废", exhausted: "邀请链接次数已用完" }[status];
        throw err(410, `invite_${status}`, text);
      }
      const member = addUserMember(team.id, user, "member");
      invite.uses += 1;
      const teamView = view(team, member);
      emit(db, { type: "team.joined", team_id: team.id, data: teamView }, { only: user.id });
      emit(db, { type: "member.joined", team_id: team.id, data: member }, { except: user.id });
      return { team: teamView, member };
    },

    async createInvite(token, teamId, input) {
      await delay();
      const me = requireManager(authed(token), teamId);
      const { expires_in_seconds: ttl, max_uses } = input;
      if (ttl !== undefined && (!Number.isInteger(ttl) || ttl < 60 || ttl > 2_592_000)) {
        throw err(400, "validation_failed", "expires_in_seconds 需在 60..2592000", { field: "expires_in_seconds" });
      }
      if (max_uses !== undefined && (!Number.isInteger(max_uses) || max_uses < 1 || max_uses > 1000)) {
        throw err(400, "validation_failed", "max_uses 需在 1..1000", { field: "max_uses" });
      }
      const code = newCode();
      const invite: Invite = {
        id: nextId(db),
        code,
        team_id: teamId,
        url_path: `/invite/${code}`,
        expires_at: ttl ? new Date(Date.now() + ttl * 1000).toISOString() : null,
        max_uses: max_uses ?? null,
        uses: 0,
        revoked_at: null,
        created_by: me.id,
        created_at: new Date().toISOString(),
      };
      db.invites.push(invite);
      return invite;
    },

    async listInvites(token, teamId) {
      await delay();
      requireManager(authed(token), teamId);
      const items = db.invites.filter((i) => i.team_id === teamId).sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
      return all(items);
    },

    async revokeInvite(token, teamId, inviteId) {
      await delay();
      requireManager(authed(token), teamId);
      const invite = db.invites.find((i) => i.id === inviteId && i.team_id === teamId);
      if (!invite) throw err(404, "not_found", "邀请不存在");
      invite.revoked_at ??= new Date().toISOString();
    },

    async register(input) {
      await delay();
      const username = input.username.trim().toLowerCase();
      if (!USERNAME_RE.test(username)) {
        throw err(400, "validation_failed", "用户名需 3–32 位，仅限 a-z 0-9 _ . -", { field: "username" });
      }
      if (input.password.length < 8 || input.password.length > 128) {
        throw err(400, "validation_failed", "密码需 8–128 位", { field: "password" });
      }
      if ([...db.users.values()].some((u) => u.username === username)) throw err(409, "conflict", "用户名已存在");
      const user: User = {
        id: nextId(db),
        username,
        display_name: input.display_name.trim() || username,
        avatar_url: null,
        created_at: new Date().toISOString(),
      };
      db.users.set(user.id, user);
      return issue(user);
    },

    async login(input) {
      await delay();
      const user = [...db.users.values()].find((u) => u.username === input.username.trim().toLowerCase());
      // mock：密码填 ratelimit 模拟 IP 限流（429 rate_limited + Retry-After）
      if (input.password === "ratelimit")
        throw ApiError.fromBody(429, { error: { code: "rate_limited", message: "too many requests" } }, "", { retryAfter: "42" });
      // mock：密码填 wrong 模拟登录失败（mock 不保存、不校验真实密码）
      if (!user || !input.password || input.password === "wrong") throw err(401, "unauthorized", "用户名或密码错误");
      return issue(user);
    },

    async logout(token) {
      await delay();
      db.sessions.delete(token);
    },

    async me(token) {
      await delay();
      return authed(token);
    },

    async updateMe(token, input) {
      await delay();
      const user = authed(token);
      const name = (input.display_name ?? "").trim();
      if ([...name].length < 1 || [...name].length > 64)
        throw err(400, "validation_failed", "显示名称需 1–64 个字", { field: "display_name" });
      user.display_name = name;
      for (const m of db.members.filter((x) => x.user_id === user.id)) {
        m.display_name = name;
        emit(db, { type: "member.updated", team_id: m.team_id, data: { ...m } });
      }
      return { ...user };
    },

    async listTeams(token) {
      await delay();
      const user = authed(token);
      const out: Team[] = [];
      for (const t of db.teams.values()) {
        const me = myMember(user, t.id);
        if (me) out.push(view(t, me));
      }
      return all(out);
    },

    async createTeam(token, input) {
      await delay();
      const user = authed(token);
      const name = input.name.trim();
      if (!name) throw err(400, "validation_failed", "Team 名称不能为空", { field: "name" });
      const rec: TeamRecord = {
        id: nextId(db),
        name,
        description: input.description ?? "",
        icon_url: null,
        owner_user_id: user.id,
        created_at: new Date().toISOString(),
      };
      db.teams.set(rec.id, rec);
      const me = addUserMember(rec.id, user, "owner");
      const general = {
        id: nextId(db),
        team_id: rec.id,
        name: "general",
        topic: "",
        is_default: true,
        created_by_member_id: me.id,
        last_message_seq: 0,
        created_at: rec.created_at,
      };
      db.channels.set(general.id, general);
      return view(rec, me);
    },

    async getTeam(token, teamId) {
      await delay();
      const user = authed(token);
      const me = requireMember(user, teamId);
      return view(db.teams.get(teamId)!, me);
    },

    async updateTeam(token, teamId, input) {
      await delay();
      const me = requireMember(authed(token), teamId);
      if (me.role !== "owner" && me.role !== "admin") throw err(403, "forbidden", "只有所有者和管理员可以修改 team");
      const rec = db.teams.get(teamId)!;
      if (input.name !== undefined) {
        const name = input.name.trim();
        if ([...name].length < 1 || [...name].length > 50) throw err(400, "validation_failed", "名称需 1–50 个字", { field: "name" });
        rec.name = name;
      }
      if (input.description !== undefined) {
        const d = input.description.trim();
        if ([...d].length > 500) throw err(400, "validation_failed", "简介最多 500 个字", { field: "description" });
        rec.description = d;
      }
      const v = view(rec, me);
      emit(db, { type: "team.updated", team_id: teamId, data: v });
      return v;
    },

    async leaveTeam(token, teamId) {
      await delay();
      const user = authed(token);
      const me = requireMember(user, teamId);
      if (me.role === "owner") throw err(409, "owner_cannot_leave", "所有者不能退出 team");
      db.members = db.members.filter((m) => m.id !== me.id);
      emit(db, { type: "team.removed", team_id: teamId, data: { team_id: teamId } }, { only: user.id });
      emit(db, { type: "member.left", team_id: teamId, data: { member_id: me.id } }, { except: user.id });
    },

    async listActiveBotRuns(token, channelId) {
      await delay();
      const user = authed(token);
      const channel = db.channels.get(channelId);
      if (!channel) throw err(404, "not_found", "频道不存在");
      requireMember(user, channel.team_id);
      const since = Date.now() - 10 * 60_000;
      return db.botRuns.filter(
        (r) => r.channel_id === channelId && ["started", "delivered", "retrying"].includes(r.status) && Date.parse(r.started_at) >= since,
      );
    },

    async listMembers(token, teamId, query = {}) {
      await delay();
      requireMember(authed(token), teamId);
      const limit = Math.min(Math.max(query.limit ?? 100, 1), 200);
      const list = db.members.filter((m) => m.team_id === teamId);
      // mock 游标：上一页最后一个 member_id
      const start = query.cursor ? list.findIndex((m) => m.id === query.cursor) + 1 : 0;
      const items = list.slice(start, start + limit);
      const has_more = start + limit < list.length;
      return { items, has_more, next_cursor: has_more ? items[items.length - 1].id : null };
    },

    async addMember(token, teamId, input) {
      await delay();
      const me = requireMember(authed(token), teamId);
      if (me.role !== "owner" && me.role !== "admin") throw err(403, "forbidden", "只有 owner/admin 可以添加成员");
      const target = [...db.users.values()].find((u) => u.username === input.username.trim().toLowerCase());
      if (!target) throw err(404, "not_found", "用户不存在");
      if (db.members.some((m) => m.team_id === teamId && m.user_id === target.id)) throw err(409, "conflict", "该用户已是成员");
      const member = addUserMember(teamId, target, input.role ?? "member");
      // 被加入者本人收 team.joined（完整 team），其他人收 member.joined
      emit(db, { type: "team.joined", team_id: teamId, data: view(db.teams.get(teamId)!, member) }, { only: target.id });
      emit(db, { type: "member.joined", team_id: teamId, data: member }, { except: target.id });
      return member;
    },

    // §3 PATCH /teams/{team_id}/members/{member_id}：owner/admin；只能设 admin/member；不能改 owner 和 bot。
    // 文档没写的（改自己、admin 改 admin、改 owner/bot 的具体错误码、响应体）这里不额外发挥：
    // owner/bot → 403 forbidden（同“移除 owner → 403”），响应体返回 Member，并向 team 推送 member.updated。
    async updateMemberRole(token, teamId, memberId, input) {
      await delay();
      const me = requireMember(authed(token), teamId);
      if (me.role !== "owner" && me.role !== "admin") throw err(403, "forbidden", "只有所有者和管理员可以修改成员角色");
      if (input.role !== "admin" && input.role !== "member")
        throw err(400, "validation_failed", "role 只能是 admin 或 member", { field: "role" });
      const idx = db.members.findIndex((m) => m.team_id === teamId && m.id === memberId);
      if (idx < 0) throw err(404, "not_found", "成员不存在");
      const target = db.members[idx];
      if (target.role === "owner" || target.type === "bot") throw err(403, "forbidden", "不能修改所有者或 bot 的角色");
      const next: Member = { ...target, role: input.role };
      db.members[idx] = next;
      if (target.role !== next.role) emit(db, { type: "member.updated", team_id: teamId, data: { ...next } });
      return next;
    },

    // §5.1 PATCH /channels/{id}：owner/admin/创建者；name 1–64、team 内不区分大小写唯一（409）；topic ≤ 250
    async updateChannel(token, channelId, input) {
      await delay();
      const channel = db.channels.get(channelId);
      if (!channel) throw err(404, "not_found", "频道不存在");
      const me = requireMember(authed(token), channel.team_id);
      const allowed = me.role === "owner" || me.role === "admin" || channel.created_by_member_id === me.id;
      if (!allowed) throw err(403, "forbidden", "只有所有者、管理员或频道创建者可以修改频道");
      const next: Channel = { ...channel };
      if (input.name !== undefined) {
        const name = input.name.trim();
        if ([...name].length < 1 || [...name].length > 64) throw err(400, "validation_failed", "频道名需 1–64 字符", { field: "name" });
        // eslint-disable-next-line no-control-regex
        if (/[\u0000-\u001f\u007f-\u009f]/.test(name)) throw err(400, "validation_failed", "name 不能包含控制字符", { field: "name" });
        const dup = [...db.channels.values()].some(
          (c) => c.team_id === channel.team_id && c.id !== channelId && c.name.toLowerCase() === name.toLowerCase(),
        );
        if (dup) throw err(409, "conflict", "频道名已存在");
        next.name = name;
      }
      if (input.topic !== undefined) {
        if ([...input.topic].length > 250) throw err(400, "validation_failed", "频道主题最多 250 字符", { field: "topic" });
        next.topic = input.topic;
      }
      db.channels.set(channelId, next);
      emit(db, { type: "channel.updated", team_id: channel.team_id, data: next });
      return next;
    },

    // §5.1 DELETE /channels/{id}：owner/admin；默认频道 403 → 204，推送 channel.deleted {id}
    async deleteChannel(token, channelId) {
      await delay();
      const channel = db.channels.get(channelId);
      if (!channel) throw err(404, "not_found", "频道不存在");
      const me = requireMember(authed(token), channel.team_id);
      if (me.role !== "owner" && me.role !== "admin") throw err(403, "forbidden", "只有所有者和管理员可以删除频道");
      if (channel.is_default) throw err(403, "forbidden", "默认频道不能删除");
      db.channels.delete(channelId);
      // 软删除：消息与其附件都不再可访问（附件刷新时进 missing，§5.1 / 变更 33）
      for (const m of db.messages) if (m.channel_id === channelId) for (const at of m.attachments) db.attachments.delete(at.id);
      db.messages = db.messages.filter((m) => m.channel_id !== channelId);
      emit(db, { type: "channel.deleted", team_id: channel.team_id, data: { id: channelId } });
    },

    // §3 GET /teams/{tid}/members/{mid}：单个成员（含 description）
    async getMember(token, teamId, memberId) {
      await delay();
      requireMember(authed(token), teamId);
      const m = db.members.find((x) => x.team_id === teamId && x.id === memberId);
      if (!m) throw err(404, "not_found", "成员不存在");
      return { ...m, description: m.type === "bot" ? (m.description ?? "") : null };
    },

    async getChannel(token, channelId) {
      await delay();
      const { user, channel } = userChannel(token, channelId);
      return channelView(user, channel);
    },

    // §5.7 POST /channels/{id}/read {seq?}：只前进；省略 = 标到最新；位置变化才推 channel.read（仅本人）
    async markChannelRead(token, channelId, seq) {
      await delay();
      const { user, channel } = userChannel(token, channelId);
      if (seq !== undefined && (!Number.isInteger(seq) || seq < 0)) throw err(400, "validation_failed", "seq 必须 ≥ 0", { field: "seq" });
      return setReadPosition(user, channel, seq ?? channel.last_message_seq);
    },

    async pinChannel(token, channelId) {
      await delay();
      return setPin(token, channelId, true);
    },

    async unpinChannel(token, channelId) {
      await delay();
      return setPin(token, channelId, false);
    },

    // §5.7 GET /me/unread：所有 team 里 unread_count > 0 或有 @ 的频道
    async listMyUnread(token) {
      await delay();
      const user = authed(token);
      const teamIds = new Set(db.members.filter((m) => m.user_id === user.id).map((m) => m.team_id));
      return [...db.channels.values()]
        .filter((c) => teamIds.has(c.team_id))
        .map((c) => userState(user, c))
        .filter((st) => st.unread_count > 0 || st.has_unread_mention);
    },

    async getMessage(token, messageId) {
      await delay();
      const user = authed(token);
      const m = db.messages.find((x) => x.id === messageId);
      if (!m || !db.channels.has(m.channel_id)) throw err(404, "not_found", "消息不存在");
      requireMember(user, m.team_id);
      return m;
    },

    // §8.7 Bot 接入 skill（mock 模式用；真实后端走 GET /api/v1/skill）
    async getSkill(opts) {
      await delay();
      if (db.skillUnavailable) throw err(503, "skill_unavailable", "skill 包暂不可用");
      const base = "http://localhost:5190/api/v1";
      const info = {
        name: "teams-skill",
        version: "1.1.0",
        install_command: `npx -y ${base}/downloads/teams-skill.tgz`,
        tgz_url: `${base}/downloads/teams-skill.tgz`,
        versioned_url: `${base}/downloads/teams-skill-1.1.0.tgz`,
        skill_md_url: `${base}/skill/SKILL.md`,
        sha256: "0".repeat(64),
        size_bytes: 12994,
        skill_name: "teams-bot-integration",
        install_path: ".cursor/skills/teams-bot-integration/SKILL.md",
        skill_md_sha256: "1".repeat(64),
      };
      return opts?.includeSkillMd ? { ...info, skill_md: MOCK_SKILL_MD } : info;
    },

    // §9.4 推送
    async getVapidPublicKey(token) {
      await delay();
      authed(token);
      return db.pushEnabled ? { enabled: true, public_key: db.vapidPublicKey } : { enabled: false, public_key: null };
    },

    async subscribePush(token, sub) {
      await delay();
      const user = authed(token);
      if (!db.pushEnabled) throw err(503, "push_disabled", "服务器未配置推送");
      if (!sub?.endpoint || !/^https:\/\//.test(sub.endpoint)) throw err(400, "validation_failed", "endpoint 必须是 https 地址", { field: "endpoint" });
      const b64len = (v: string | undefined) => (v ? Math.floor((v.replace(/=+$/, "").length * 3) / 4) : 0);
      if (b64len(sub.keys?.p256dh) !== 65) throw err(400, "validation_failed", "keys.p256dh 无效", { field: "keys.p256dh" });
      if (b64len(sub.keys?.auth) !== 16) throw err(400, "validation_failed", "keys.auth 无效", { field: "keys.auth" });
      const now = new Date().toISOString();
      const prev = db.pushSubscriptions.get(sub.endpoint);
      const rec = { id: prev?.id ?? nextId(db), user_id: user.id, endpoint: sub.endpoint, created_at: prev?.created_at ?? now, updated_at: now };
      db.pushSubscriptions.set(sub.endpoint, rec);
      return { id: rec.id, endpoint: rec.endpoint, created_at: rec.created_at, updated_at: rec.updated_at };
    },

    async unsubscribePush(token, endpoint) {
      await delay();
      const user = authed(token);
      if (!endpoint) throw err(400, "validation_failed", "缺少 endpoint", { field: "endpoint" });
      const rec = db.pushSubscriptions.get(endpoint);
      if (rec && rec.user_id === user.id) db.pushSubscriptions.delete(endpoint);
    },

    // §10.1 PUT /me/avatar：只收 jpeg/png/gif/webp（嗅探），≤ 5 MB；→ User，向用户所在每个 team 推 member.updated
    async uploadMyAvatar(token, file) {
      await delay();
      const user = authed(token);
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (bytes.length > AVATAR_MAX_BYTES) throw err(413, "payload_too_large", "头像不能超过 5 MB", { max_bytes: AVATAR_MAX_BYTES });
      const type = sniffImage(bytes);
      if (!type || !AVATAR_TYPES.includes(type)) throw err(415, "unsupported_media_type", "只支持 jpg、png、gif、webp", { detected: type ?? "unknown" });
      // 宽或高 > 4096 直接拒绝（mock 只能不解码地读出 GIF 尺寸）
      const dim = gifSize(bytes);
      if (dim && (dim.width > AVATAR_MAX_DIM || dim.height > AVATAR_MAX_DIM))
        throw err(400, "validation_failed", "图片尺寸不能超过 4096×4096", { field: "avatar" });
      let bin = "";
      for (const b of bytes) bin += String.fromCharCode(b);
      return setMyAvatar(user, `data:${type};base64,${btoa(bin)}`);
    },

    async deleteMyAvatar(token) {
      await delay();
      const user = authed(token);
      // 幂等：本来就没有头像也 200，但不推送（§1）
      if (!user.avatar_url) return { ...user };
      return setMyAvatar(user, null);
    },

    async listChannels(token, teamId) {
      await delay();
      const user = authed(token);
      requireMember(user, teamId);
      return all(
        [...db.channels.values()]
          .filter((c) => c.team_id === teamId)
          .sort((a, b) => Number(b.is_default) - Number(a.is_default) || a.created_at.localeCompare(b.created_at))
          .map((c) => channelView(user, c)),
      );
    },

    async createChannel(token, teamId, input) {
      await delay();
      const me = requireMember(authed(token), teamId);
      const name = input.name.trim();
      if (![...name].length || [...name].length > 64) throw err(400, "validation_failed", "name 长度需在 1–64 之间", { field: "name" });
      // eslint-disable-next-line no-control-regex
      if (/[\u0000-\u001f\u007f-\u009f]/.test(name)) throw err(400, "validation_failed", "name 不能包含控制字符", { field: "name" });
      if ([...db.channels.values()].some((c) => c.team_id === teamId && c.name.toLowerCase() === name.toLowerCase())) {
        throw err(409, "conflict", "频道名已存在", { field: "name" });
      }
      const channel = {
        id: nextId(db),
        team_id: teamId,
        name,
        topic: input.topic ?? "",
        is_default: false,
        created_by_member_id: me.id,
        last_message_seq: 0,
        created_at: new Date().toISOString(),
      };
      db.channels.set(channel.id, channel);
      emit(db, { type: "channel.created", team_id: teamId, data: channel });
      return channel;
    },

    async listMessages(token, channelId, query = {}) {
      await delay();
      const user = authed(token);
      const channel = db.channels.get(channelId);
      if (!channel) throw err(404, "not_found", "频道不存在");
      requireMember(user, channel.team_id);
      const limit = Math.min(query.limit ?? 50, 100);
      let list = db.messages.filter((m) => m.channel_id === channelId).sort((a, b) => a.seq - b.seq);
      // items 一律按 seq 升序；next_cursor：无参/before = 本页最小 seq，after = 本页最大 seq
      let has_more: boolean;
      let next_cursor: string | null;
      if (query.after !== undefined) {
        list = list.filter((m) => m.seq > query.after!);
        has_more = list.length > limit;
        list = list.slice(0, limit);
        next_cursor = list.length ? String(list[list.length - 1].seq) : null;
      } else {
        if (query.before !== undefined) list = list.filter((m) => m.seq < query.before!);
        has_more = list.length > limit;
        list = list.slice(-limit);
        next_cursor = list.length ? String(list[0].seq) : null;
      }
      return { items: list, has_more, next_cursor };
    },

    async answerQA(token, id, {question, choice, text}) {
      const msg = await this.getMessage(token, id);
      const card = msg.qa_card;
      if (!card || msg.deleted) throw err(404, "not_found", "QA 卡片不存在");
      if (card.recipient_member_id !== requireMember(authed(token), msg.team_id).id) throw err(403, "forbidden", "只有绑定人可以回答");
      const q = card.questions[question];
      if (!q || !(choice === "skip" || (choice === "other" ? text?.trim() && text.trim().length <= 2000 : q.options.some((_, i) => choice === "ABCD"[i])))) throw err(400, "validation_failed", "答案无效");
      const answer = choice === "other" ? { choice, text: text!.trim() } : { choice };
      if (q.answer?.choice === choice && q.answer.text === answer.text) return msg;
      if (q.answer && q.answer.choice !== "skip") throw err(409, "conflict", "该题已回答");
      const next = { ...msg, qa_card: { ...card, revision: card.revision+1, questions: card.questions.map((item,i)=>i===question ? {...item, answer} : item) } };
      db.messages[db.messages.indexOf(msg)] = next;
      emit(db, { type: "message.updated", team_id: msg.team_id, data: next });
      return next;
    },

    async sendMessage(token, channelId, input) {
      await delay();
      const user = authed(token);
      const channel = db.channels.get(channelId);
      if (!channel) throw err(404, "not_found", "频道不存在");
      const me = requireMember(user, channel.team_id);
      const qa = input.qa_card;
      if (qa) {
        if (!db.members.some(m => m.team_id === channel.team_id && m.id === qa.recipient_member_id) || !qa.questions.length || qa.questions.length > 64
          || qa.questions.some(q => !q.prompt.trim() || q.prompt.length > 500 || q.options.length > 4 || q.options.some(o => !o.trim() || o.trim() === "其他" || o.length > 160))) throw err(400,"validation_failed","请检查回答人、问题和选项");
        input = {...input,content: `<@${qa.recipient_member_id}> QA 卡片 · ${qa.questions[0].prompt}`};
      }
      if (!input.content.trim() && input.attachment_ids.length === 0) {
        throw err(400, "validation_failed", "content 和 attachment_ids 不能同时为空", { field: "content" });
      }
      if (input.content.length > 8000) throw err(400, "validation_failed", "content 最长 8000 字符");
      // mock：正文含 [fail] 模拟发送失败（演示失败标记、重发、删除）
      if (input.content.includes("[fail]")) throw err(503, "internal", "服务暂时不可用（mock 模拟发送失败）");
      if (input.attachment_ids.length > 10) throw err(400, "validation_failed", "attachment_ids 最多 10 个");
      if (input.client_msg_id !== undefined) {
        if (!CLIENT_MSG_ID_RE.test(input.client_msg_id)) {
          throw err(400, "validation_failed", "client_msg_id 需 1–64 位 [A-Za-z0-9_-]", { field: "client_msg_id" });
        }
        const prevId = db.clientMsgIds.get(`${me.id}:${input.client_msg_id}`);
        const prev = prevId ? db.messages.find((m) => m.id === prevId) : undefined;
        if (prev) return prev;
      }
      const attachments: Attachment[] = input.attachment_ids.map((id) => {
        const a = db.attachments.get(id);
        if (!a || db.usedAttachments.has(id)) throw err(400, "validation_failed", "附件不可用", { field: "attachment_ids" });
        return a;
      });
      attachments.forEach((a) => db.usedAttachments.add(a.id));
      // §4.2：服务端解析 <@uuid>，只保留本 team 成员，去重保序，最多 20 个
      const teamMembers = db.members.filter((m) => m.team_id === channel.team_id);
      const seen = new Set<string>();
      const mentions = [...input.content.matchAll(/<@([0-9A-Za-z_-]+)>/g)]
        .map((m) => teamMembers.find((x) => x.id === m[1]))
        .filter((m): m is Member => !!m && !seen.has(m.id) && !!seen.add(m.id))
        .slice(0, 20)
        .map((m) => ({ member_id: m.id, type: m.type, display_name: m.display_name }));
      const message: Message = {
        id: nextId(db),
        seq: nextSeq(db),
        team_id: channel.team_id,
        channel_id: channelId,
        sender: senderOf(me),
        kind: "message",
        content: input.content,
        mentions: qa ? mentions.filter(x => x.member_id===qa.recipient_member_id) : mentions,
        qa_card: qa && {...qa,revision:0},
        attachments,
        reply_to: input.reply_to ?? null,
        trigger_depth: 0,
        created_at: new Date().toISOString(),
        edited_at: null,
        deleted: false,
      };
      db.messages.push(message);
      if (input.client_msg_id) db.clientMsgIds.set(`${me.id}:${input.client_msg_id}`, message.id);
      channel.last_message_seq = message.seq;
      emit(db, { type: "message.created", team_id: channel.team_id, data: message });
      // 自己发消息 = 自动已读到这条，并给自己推 channel.read（§5.7）
      setReadPosition(user, channel, message.seq);
      return message;
    },

    async uploadAttachment(token, teamId, file, opts = {}) {
      requireMember(authed(token), teamId);
      // mock：按文件大小模拟上传进度（约 1.5–4 秒），支持 AbortSignal 取消
      if (latency > 0 || opts.onProgress) {
        const steps = 20;
        const stepMs = latency > 0 ? Math.min(200, 75 + file.size / 200_000) : 0;
        for (let i = 1; i <= steps; i++) {
          if (opts.signal?.aborted) throw new DOMException("上传已取消", "AbortError");
          await new Promise((r) => setTimeout(r, stepMs));
          if (opts.signal?.aborted) throw new DOMException("上传已取消", "AbortError");
          opts.onProgress?.(i / steps);
        }
      }
      const check = checkUpload(file);
      if (!check.ok) {
        const tooLarge = check.reason.includes("超过");
        throw err(tooLarge ? 413 : 415, tooLarge ? "payload_too_large" : "unsupported_media_type", check.reason);
      }
      const attachment: Attachment = {
        id: nextId(db),
        kind: check.kind,
        mime_type: file.type,
        size_bytes: file.size,
        file_name: file.name,
        width: null,
        height: null,
        duration_ms: null,
        url: typeof URL.createObjectURL === "function" ? URL.createObjectURL(file) : "",
        expires_at: inOneHour(),
      };
      db.attachments.set(attachment.id, attachment);
      return attachment;
    },

    async getAttachment(token, id) {
      await delay();
      authed(token);
      const a = db.attachments.get(id);
      if (!a) throw err(404, "not_found", "附件不存在");
      return signed(a);
    },

    async refreshAttachmentUrls(token, ids) {
      await delay();
      authed(token);
      if (ids.length > 100) throw err(400, "validation_failed", "ids 最多 100 个", { field: "ids" });
      const uniq = [...new Set(ids)];
      if (uniq.length < 1) throw err(400, "validation_failed", "ids 不能为空", { field: "ids" });
      return {
        items: uniq.map((id) => db.attachments.get(id)).filter((a): a is Attachment => !!a).map(signed),
        missing: uniq.filter((id) => !db.attachments.has(id)),
      };
    },
  };

  /** mock 无真实签名：URL 原样返回，expires_at 顺延 1 小时 */
  function signed(a: Attachment): Attachment {
    a.expires_at = inOneHour();
    return { ...a };
  }
}

const MOCK_SKILL_MD = `---
name: teams-bot-integration
description: （mock）把 AI agent 接入 TeAms 当 bot：webhook 载荷、bot 令牌接口、防循环。
---

# TeAms Bot 接入（mock 预览）

这是 mock 模式下的示例内容，真实内容来自后端 GET /api/v1/skill?include=skill_md。
`;
