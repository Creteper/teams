import type {
  AddMemberInput,
  Attachment,
  AcceptInviteResponse,
  AttachmentUrlsResponse,
  UpdateMeInput,
  UpdateMemberRoleInput,
  UpdateChannelInput,
  Bot,
  AuthResponse,
  BotRunItem,
  UpdateTeamInput,
  CreateInviteInput,
  Invite,
  InvitePreview,
  Channel,
  CreateChannelInput,
  CreateTeamInput,
  ID,
  LoginInput,
  Member,
  MemberPageQuery,
  Message,
  MessagePageQuery,
  Page,
  ReadyData,
  RegisterInput,
  SendMessageInput,
  ServerFrame,
  Team,
  User,
} from "./types";

/**
 * 页面只依赖这个接口，不关心是 mock 还是真实后端（VITE_USE_MOCK 切换）。
 * 每个方法注释里写了对应的 docs/api.md 接口。
 */
export interface TeamsApi {
  /** POST /api/v1/auth/register */
  register(input: RegisterInput): Promise<AuthResponse>;
  /** POST /api/v1/auth/login */
  login(input: LoginInput): Promise<AuthResponse>;
  /** POST /api/v1/auth/logout */
  logout(token: string): Promise<void>;
  /** GET /api/v1/me */
  me(token: string): Promise<User>;
  /** PATCH /api/v1/me {display_name} → User；推送 member.updated */
  updateMe(token: string, input: UpdateMeInput): Promise<User>;

  /** GET /api/v1/teams（一次返回全部） */
  listTeams(token: string): Promise<Page<Team>>;
  /** POST /api/v1/teams */
  createTeam(token: string, input: CreateTeamInput): Promise<Team>;
  /** GET /api/v1/teams/{team_id} */
  getTeam(token: string, teamId: ID): Promise<Team>;
  /** PATCH /api/v1/teams/{team_id}（owner/admin）{name?, description?} */
  updateTeam(token: string, teamId: ID, input: UpdateTeamInput): Promise<Team>;
  /** DELETE /api/v1/teams/{team_id}/members/me；所有者 → 409 owner_cannot_leave */
  leaveTeam(token: string, teamId: ID): Promise<void>;

  /** GET /api/v1/teams/{team_id}/members?limit&cursor（分页，见 fetchAllMembers） */
  listMembers(token: string, teamId: ID, query?: MemberPageQuery): Promise<Page<Member>>;
  /** POST /api/v1/teams/{team_id}/members（owner/admin 按用户名添加） */
  addMember(token: string, teamId: ID, input: AddMemberInput): Promise<Member>;
  /**
   * PATCH /api/v1/teams/{team_id}/members/{member_id} {role: "admin"|"member"}（owner/admin；不能改 owner 和 bot）。
   * 文档未写明响应体；返回值可能不是 Member（调用方按 isMember 判断，否则保留乐观值）。
   */
  updateMemberRole(token: string, teamId: ID, memberId: ID, input: UpdateMemberRoleInput): Promise<Member | null>;

  /** GET /api/v1/teams/{team_id}/channels（一次返回全部） */
  listChannels(token: string, teamId: ID): Promise<Page<Channel>>;
  /** POST /api/v1/teams/{team_id}/channels */
  createChannel(token: string, teamId: ID, input: CreateChannelInput): Promise<Channel>;

  /** PATCH /api/v1/channels/{channel_id}（owner/admin/创建者）{name?, topic?} → Channel；推送 channel.updated */
  updateChannel(token: string, channelId: ID, input: UpdateChannelInput): Promise<Channel>;
  /** DELETE /api/v1/channels/{channel_id}（owner/admin；默认频道 403）→ 204；推送 channel.deleted {id} */
  deleteChannel(token: string, channelId: ID): Promise<void>;
  /** GET /api/v1/bots/{bot_id}（成员可读；资料卡取 description） */
  getBot(token: string, botId: ID): Promise<Bot>;
  /** PUT /api/v1/me/avatar（multipart 字段 file）→ User（§1、§10） */
  uploadMyAvatar(token: string, file: Blob, filename: string): Promise<User>;
  /** DELETE /api/v1/me/avatar → User */
  deleteMyAvatar(token: string): Promise<User>;

  /** GET /api/v1/channels/{channel_id}/messages?limit&before|after（items 按 seq 升序） */
  listMessages(token: string, channelId: ID, query?: MessagePageQuery): Promise<Page<Message>>;
  /** POST /api/v1/channels/{channel_id}/messages */
  sendMessage(token: string, channelId: ID, input: SendMessageInput): Promise<Message>;

  /** POST /api/v1/teams/{team_id}/attachments（multipart，字段 file）；支持进度和取消 */
  uploadAttachment(token: string, teamId: ID, file: File, opts?: UploadOptions): Promise<Attachment>;
  /** GET /api/v1/channels/{channel_id}/bot-runs?active=true → {items}（10 分钟内进行中的） */
  listActiveBotRuns(token: string, channelId: ID): Promise<BotRunItem[]>;
  /** GET /api/v1/invites/{code}（无需登录）；不存在 → 404 invite_not_found */
  previewInvite(code: string): Promise<InvitePreview>;
  /** POST /api/v1/invites/{code}/accept；失效 → 410 invite_expired/invite_revoked/invite_exhausted */
  acceptInvite(token: string, code: string): Promise<AcceptInviteResponse>;
  /** POST /api/v1/teams/{team_id}/invites（owner/admin） */
  createInvite(token: string, teamId: ID, input: CreateInviteInput): Promise<Invite>;
  /** GET /api/v1/teams/{team_id}/invites（owner/admin） */
  listInvites(token: string, teamId: ID): Promise<Page<Invite>>;
  /** DELETE /api/v1/teams/{team_id}/invites/{invite_id}（owner/admin，作废） */
  revokeInvite(token: string, teamId: ID, inviteId: ID): Promise<void>;

  /** GET /api/v1/attachments/{id}：刷新单个签名 URL */
  getAttachment(token: string, attachmentId: ID): Promise<Attachment>;
  /** POST /api/v1/attachments/urls {ids}（≤100）：批量刷新签名 URL */
  refreshAttachmentUrls(token: string, ids: ID[]): Promise<AttachmentUrlsResponse>;
}

/** members 分页：循环拉完（limit 默认 100，最大 200） */
export async function fetchAllMembers(api: TeamsApi, token: string, teamId: ID, limit = 200): Promise<Member[]> {
  const all: Member[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 1000; i++) {
    const page = await api.listMembers(token, teamId, { limit, cursor });
    all.push(...page.items);
    if (!page.has_more || !page.next_cursor) break;
    cursor = page.next_cursor;
  }
  return all;
}

export interface UploadOptions {
  /** 0..1 */
  onProgress?(fraction: number): void;
  signal?: AbortSignal;
}

export type FrameHandler = (frame: ServerFrame) => void;

/**
 * 实时通道（§8）：连接后自动收到用户所在全部 team 的事件。
 * 发消息只走 REST，这里只收推送。
 */
export interface RealtimeClient {
  connect(token: string): void;
  disconnect(): void;
  /** 订阅全部推送帧，返回取消函数 */
  subscribe(handler: FrameHandler): () => void;
  /** 每次（重）连鉴权成功收到 ready 时回调，用于 after=<seq> 补拉 */
  onReady(handler: (data: ReadyData) => void): () => void;
  /** 鉴权失败（close 4401）时回调 */
  onAuthFailed(handler: () => void): () => void;
}
