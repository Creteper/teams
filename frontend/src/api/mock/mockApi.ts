import type { TeamsApi } from "../client";
import { ApiError } from "../errors";
import type { Attachment, AuthResponse, Member, Message, Team, User } from "../types";
import { checkUpload } from "../../lib/upload";
import { emit, nextId, nextSeq, type MockDb, type TeamRecord } from "./db";

/**
 * Mock 实现：内存数据 + 少量延迟，校验规则和错误码尽量贴近 docs/api.md。
 * 不保存、不校验密码（仅按文档做长度校验）；令牌是 mock 随机串。
 */

const USERNAME_RE = /^[a-z0-9_.-]{3,32}$/;

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
      role,
      joined_at: new Date().toISOString(),
    };
    db.members.push(member);
    return member;
  }

  return {
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
      if (!user || !input.password) throw err(401, "unauthorized", "用户名或密码错误");
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

    async listTeams(token) {
      await delay();
      const user = authed(token);
      const out: Team[] = [];
      for (const t of db.teams.values()) {
        const me = myMember(user, t.id);
        if (me) out.push(view(t, me));
      }
      return out;
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

    async listMembers(token, teamId) {
      await delay();
      requireMember(authed(token), teamId);
      return db.members.filter((m) => m.team_id === teamId);
    },

    async addMember(token, teamId, input) {
      await delay();
      const me = requireMember(authed(token), teamId);
      if (me.role !== "owner" && me.role !== "admin") throw err(403, "forbidden", "只有 owner/admin 可以添加成员");
      const target = [...db.users.values()].find((u) => u.username === input.username.trim().toLowerCase());
      if (!target) throw err(404, "not_found", "用户不存在");
      if (db.members.some((m) => m.team_id === teamId && m.user_id === target.id)) throw err(409, "conflict", "该用户已是成员");
      const member = addUserMember(teamId, target, input.role ?? "member");
      emit(db, { type: "member.joined", team_id: teamId, data: member });
      return member;
    },

    async listChannels(token, teamId) {
      await delay();
      requireMember(authed(token), teamId);
      return [...db.channels.values()].filter((c) => c.team_id === teamId).sort((a, b) => a.created_at.localeCompare(b.created_at));
    },

    async createChannel(token, teamId, input) {
      await delay();
      const me = requireMember(authed(token), teamId);
      const name = input.name.trim();
      if (!name || name.length > 64) throw err(400, "validation_failed", "频道名需 1–64 字符", { field: "name" });
      if ([...db.channels.values()].some((c) => c.team_id === teamId && c.name.toLowerCase() === name.toLowerCase())) {
        throw err(409, "conflict", "频道已存在");
      }
      const channel = {
        id: nextId(db),
        team_id: teamId,
        name,
        topic: input.topic ?? "",
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
      let has_more: boolean;
      if (query.after !== undefined) {
        list = list.filter((m) => m.seq > query.after!);
        has_more = list.length > limit;
        list = list.slice(0, limit);
      } else {
        if (query.before !== undefined) list = list.filter((m) => m.seq < query.before!);
        has_more = list.length > limit;
        list = list.slice(-limit);
      }
      return { items: list, has_more, next_cursor: has_more && list.length ? String(list[0].seq) : null };
    },

    async sendMessage(token, channelId, input) {
      await delay();
      const user = authed(token);
      const channel = db.channels.get(channelId);
      if (!channel) throw err(404, "not_found", "频道不存在");
      const me = requireMember(user, channel.team_id);
      if (!input.content.trim() && input.attachment_ids.length === 0) {
        throw err(400, "validation_failed", "content 和 attachment_ids 不能同时为空", { field: "content" });
      }
      if (input.content.length > 8000) throw err(400, "validation_failed", "content 最长 8000 字符");
      if (input.attachment_ids.length > 10) throw err(400, "validation_failed", "attachment_ids 最多 10 个");
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
        sender: { member_id: me.id, type: "user", display_name: me.display_name, avatar_url: me.avatar_url },
        content: input.content,
        mentions,
        attachments,
        reply_to: input.reply_to ?? null,
        trigger_depth: 0,
        created_at: new Date().toISOString(),
        edited_at: null,
        deleted: false,
      };
      db.messages.push(message);
      channel.last_message_seq = message.seq;
      emit(db, { type: "message.created", team_id: channel.team_id, data: message });
      return message;
    },

    async uploadAttachment(token, teamId, file) {
      await delay();
      requireMember(authed(token), teamId);
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
      };
      db.attachments.set(attachment.id, attachment);
      return attachment;
    },
  };
}
