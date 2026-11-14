import type { TeamsApi } from "../client";
import { ApiError } from "../errors";
import type { Attachment, AttachmentUrl, AuthResponse, Invite, Member, Message, Page, Team, User } from "../types";
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

    async listChannels(token, teamId) {
      await delay();
      requireMember(authed(token), teamId);
      return all([...db.channels.values()].filter((c) => c.team_id === teamId).sort((a, b) => a.created_at.localeCompare(b.created_at)));
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
      if (input.client_msg_id) db.clientMsgIds.set(`${me.id}:${input.client_msg_id}`, message.id);
      channel.last_message_seq = message.seq;
      emit(db, { type: "message.created", team_id: channel.team_id, data: message });
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
      };
      db.attachments.set(attachment.id, attachment);
      return attachment;
    },

    async getAttachmentUrl(token, id) {
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
      return ids.map((id) => db.attachments.get(id)).filter((a): a is Attachment => !!a).map(signed);
    },
  };

  /** mock 无真实签名：URL 原样返回，expires_at = 现在 + 1 小时 */
  function signed(a: Attachment): AttachmentUrl {
    return { id: a.id, url: a.url, expires_at: new Date(Date.now() + 3600_000).toISOString() };
  }
}
