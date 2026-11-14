/**
 * TeAms 接口数据类型 —— 按 docs/api.md（v1 第一阶段定稿草案）编写，字段保持 snake_case。
 * mock 实现与真实实现共用这些类型。文档如有变更，以 docs/api.md 为准同步修改此文件。
 */

/** UUID 字符串（v7） */
export type ID = string;
/** RFC 3339 UTC 毫秒时间 */
export type Timestamp = string;

// ---------- 认证 / 用户（§1） ----------

export interface User {
  id: ID;
  username: string;
  display_name: string;
  /** null 或 `/api/v1/avatars/<avatar_id>`（§10） */
  avatar_url: string | null;
  created_at: Timestamp;
}

/** 注册 / 登录响应 */
export interface AuthResponse {
  user: User;
  token: string;
  expires_at: Timestamp;
}

export interface RegisterInput {
  username: string;
  password: string;
  display_name: string;
}

export interface LoginInput {
  username: string;
  password: string;
}

// ---------- Team（§2） ----------

export type TeamRole = "owner" | "admin" | "member";
export type MemberRole = TeamRole | "bot";

export interface Team {
  id: ID;
  name: string;
  description: string;
  /** null 或 `/api/v1/avatars/<avatar_id>`；为空时前端显示默认首字母图标 */
  icon_url: string | null;
  owner_user_id: ID;
  my_member_id: ID;
  my_role: TeamRole;
  created_at: Timestamp;
}

export interface CreateTeamInput {
  name: string;
  description?: string;
}

// ---------- 成员（§2.1） ----------

export type MemberType = "user" | "bot";

export interface Member {
  /** member_id：@ 和发消息都用它 */
  id: ID;
  team_id: ID;
  type: MemberType;
  user_id: ID | null;
  bot_id: ID | null;
  display_name: string;
  username: string;
  /** null 或 `/api/v1/avatars/<avatar_id>`；bot 头像由后端从 Grok Bot 同步 */
  avatar_url: string | null;
  /** 程序化 bot 头像形状（如 "blob"），原样存储不保证小写；用户成员始终为 null */
  avatar_shape: string | null;
  /** 程序化 bot 头像颜色（如 "black"），原样存储不保证小写；用户成员始终为 null */
  avatar_color: string | null;
  role: MemberRole;
  joined_at: Timestamp;
}

/** PATCH /teams/{team_id}/members/{member_id}（§3）：只能在 admin / member 之间切换 */
export interface UpdateMemberRoleInput {
  role: "admin" | "member";
}

export interface AddMemberInput {
  username: string;
  role?: Exclude<TeamRole, "owner">;
}

// ---------- 频道（§3） ----------

export interface Channel {
  id: ID;
  team_id: ID;
  name: string;
  topic: string;
  /** 默认频道（general）：不能删除（§5.1） */
  is_default: boolean;
  created_by_member_id: ID;
  last_message_seq: number;
  created_at: Timestamp;
}

/** PATCH /channels/{id}（§5.1）：owner/admin/创建者 */
export interface UpdateChannelInput {
  name?: string;
  topic?: string;
}

/** Bot 对象（§8.1）；成员资料卡只用到 description 等公开字段 */
export interface Bot {
  id: ID;
  member_id: ID;
  team_id: ID;
  name: string;
  display_name: string;
  description: string;
  avatar_url: string | null;
  avatar_source_url?: string | null;
  avatar_shape: string | null;
  avatar_color: string | null;
  /** 非 owner/admin 读取时为 null */
  webhook: unknown | null;
  created_at: Timestamp;
}

export interface CreateChannelInput {
  name: string;
  topic?: string;
}

// ---------- 消息（§4） ----------

export interface MessageSender {
  member_id: ID;
  type: MemberType;
  display_name: string;
  avatar_url: string | null;
  /** 原样存储，不保证小写；前端解析时 trim + 忽略大小写 */
  avatar_shape: string | null;
  avatar_color: string | null;
}

export interface MessageMention {
  member_id: ID;
  type: MemberType;
  display_name: string;
}

export type AttachmentKind = "image" | "video";

export interface Attachment {
  id: ID;
  kind: AttachmentKind;
  mime_type: string;
  size_bytes: number;
  file_name: string;
  width: number | null;
  height: number | null;
  /** 目前恒为 null（后端未解析视频时长） */
  duration_ms: number | null;
  /** 相对路径签名 URL（1 小时有效），可直接给 <img>/<video> */
  url: string;
  /** 签名到期时间 */
  expires_at: Timestamp;
}

/** POST /attachments/urls 响应（docs/api.md §6.2） */
export interface AttachmentUrlsResponse {
  /** 保持请求顺序 */
  items: Attachment[];
  /** 不可见或不存在的 id */
  missing: ID[];
}

/** PATCH /me */
export interface UpdateMeInput {
  display_name: string;
}

export interface Message {
  id: ID;
  seq: number;
  team_id: ID;
  channel_id: ID;
  sender: MessageSender;
  /** 正文，提及写作 `<@member_id>` */
  content: string;
  mentions: MessageMention[];
  attachments: Attachment[];
  reply_to: ID | null;
  trigger_depth: number;
  created_at: Timestamp;
  edited_at: Timestamp | null;
  deleted: boolean;
}

export interface SendMessageInput {
  content: string;
  attachment_ids: ID[];
  reply_to?: ID;
  client_msg_id?: string;
}

/** 附件签名 URL 刷新结果：GET /attachments/{id}、POST /attachments/urls */

/**
 * 消息分页：before/after 是 seq 游标。items 一律按 seq 升序；
 * next_cursor 为 seq 十进制字符串：无参/before 时是本页最小 seq，after 时是本页最大 seq。
 */
export interface MessagePageQuery {
  limit?: number;
  before?: number;
  after?: number;
}

/** 成员分页：limit 默认 100、最大 200；cursor 取上一页 next_cursor */
export interface MemberPageQuery {
  limit?: number;
  cursor?: string;
}

/** 通用分页响应（§0.3）：teams/channels/members/messages/invites 一律用此形状 */
export interface Page<T> {
  items: T[];
  next_cursor: string | null;
  has_more: boolean;
}

// ---------- Bot 处理状态（docs/api.md §7.6） ----------

export type BotRunFailReason = "no_webhook" | "timeout" | "network_error" | "http_error" | "invalid_url" | "message_deleted";
export type BotRunStatus = "started" | "delivered" | "retrying" | "failed" | "completed";

/** bot.run.* 事件的 data（每条都带 team_id、channel_id、bot_member_id、trigger_message_id、delivery_id、at） */
export interface BotRunEvent {
  team_id: ID;
  channel_id: ID;
  bot_member_id: ID;
  trigger_message_id: ID;
  delivery_id: ID;
  at: Timestamp;
  /** retrying */
  attempt?: number | null;
  next_retry_at?: Timestamp | null;
  /** retrying / failed */
  reason?: BotRunFailReason | string | null;
  status_code?: number | null;
  /** completed */
  reply_message_id?: ID;
}

/** GET /channels/{id}/bot-runs?active=true 的条目（docs/api.md §7.6） */
export interface BotRunItem {
  delivery_id: ID;
  team_id: ID;
  channel_id: ID;
  bot_member_id: ID;
  trigger_message_id: ID;
  status: BotRunStatus;
  attempt?: number | null;
  next_retry_at?: Timestamp | null;
  reason?: BotRunFailReason | string | null;
  status_code?: number | null;
  reply_message_id?: ID | null;
  started_at: Timestamp;
  updated_at: Timestamp;
}

export interface UpdateTeamInput {
  /** 1–50 字符（Unicode 计数，首尾空白去掉） */
  name?: string;
  /** 0–500 字符 */
  description?: string;
}

// ---------- 邀请链接（Gus 定稿，待写入 docs/api.md） ----------

export type InviteInvalidReason = "expired" | "revoked" | "exhausted";

export interface Invite {
  id: ID;
  code: string;
  team_id: ID;
  /** 站内路径，如 `/invite/<code>`；完整链接 = location.origin + url_path */
  url_path: string;
  /** null = 永久 */
  expires_at: Timestamp | null;
  /** null = 不限次 */
  max_uses: number | null;
  uses: number;
  revoked_at: Timestamp | null;
  created_by: ID;
  created_at: Timestamp;
}

/** GET /invites/{code}（无需登录） */
export interface InvitePreview {
  code: string;
  team: { id: ID; name: string; icon_url: string | null; member_count: number };
  expires_at: Timestamp | null;
  valid: boolean;
  reason?: InviteInvalidReason;
}

export interface CreateInviteInput {
  /** 60..2592000；不填 = 永久 */
  expires_in_seconds?: number;
  /** 1..1000；不填 = 不限次 */
  max_uses?: number;
}

/** POST /invites/{code}/accept */
export interface AcceptInviteResponse {
  team: Team;
  member: Member;
  already_member?: boolean;
}

// ---------- 错误（§0.2） ----------

export interface ApiErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> };
  request_id?: string;
}

// ---------- WebSocket（§8） ----------

export interface ReadyData {
  member_ids: Record<ID, ID>;
  server_time: Timestamp;
  last_seq: number;
}

interface FrameBase {
  id?: string;
  ts?: Timestamp;
  team_id?: ID;
}

/** 服务端 → 客户端帧。team 范围事件（message.* / channel.* / member.* / team.*）带 team_id；ready/pong/error 不带 */
export type ServerFrame = FrameBase &
  (
    | { type: "ready"; data: ReadyData }
    | { type: "message.created" | "message.updated"; data: Message }
    | { type: "message.deleted"; data: { id: ID; channel_id: ID; seq: number } }
    | { type: "channel.created" | "channel.updated"; data: Channel }
    | { type: "channel.deleted"; data: { id: ID } }
    | { type: "member.joined" | "member.updated"; data: Member }
    | { type: "member.left"; data: { member_id: ID } }
    | { type: "team.updated" | "team.joined"; data: Team }
    | {
        type: "bot.run.started" | "bot.run.delivered" | "bot.run.retrying" | "bot.run.failed" | "bot.run.completed";
        data: BotRunEvent;
      }
    | { type: "team.deleted" | "team.removed"; data: { team_id: ID } }
    | { type: "pong"; data: Record<string, never> }
    | { type: "error"; data: { code: string; message?: string } }
  );

/** 客户端 → 服务端帧 */
export type ClientFrame = { type: "auth"; token: string } | { type: "ping" };
