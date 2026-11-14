import type {
  AddMemberInput,
  Attachment,
  AttachmentUrl,
  AuthResponse,
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

  /** GET /api/v1/teams（一次返回全部） */
  listTeams(token: string): Promise<Page<Team>>;
  /** POST /api/v1/teams */
  createTeam(token: string, input: CreateTeamInput): Promise<Team>;
  /** GET /api/v1/teams/{team_id} */
  getTeam(token: string, teamId: ID): Promise<Team>;

  /** GET /api/v1/teams/{team_id}/members?limit&cursor（分页，见 fetchAllMembers） */
  listMembers(token: string, teamId: ID, query?: MemberPageQuery): Promise<Page<Member>>;
  /** POST /api/v1/teams/{team_id}/members（owner/admin 按用户名添加） */
  addMember(token: string, teamId: ID, input: AddMemberInput): Promise<Member>;

  /** GET /api/v1/teams/{team_id}/channels（一次返回全部） */
  listChannels(token: string, teamId: ID): Promise<Page<Channel>>;
  /** POST /api/v1/teams/{team_id}/channels */
  createChannel(token: string, teamId: ID, input: CreateChannelInput): Promise<Channel>;

  /** GET /api/v1/channels/{channel_id}/messages?limit&before|after（items 按 seq 升序） */
  listMessages(token: string, channelId: ID, query?: MessagePageQuery): Promise<Page<Message>>;
  /** POST /api/v1/channels/{channel_id}/messages */
  sendMessage(token: string, channelId: ID, input: SendMessageInput): Promise<Message>;

  /** POST /api/v1/teams/{team_id}/attachments（multipart，字段 file） */
  uploadAttachment(token: string, teamId: ID, file: File): Promise<Attachment>;
  /** GET /api/v1/attachments/{id}：刷新单个签名 URL */
  getAttachmentUrl(token: string, attachmentId: ID): Promise<AttachmentUrl>;
  /** POST /api/v1/attachments/urls {ids}（≤100）：批量刷新签名 URL */
  refreshAttachmentUrls(token: string, ids: ID[]): Promise<AttachmentUrl[]>;
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
