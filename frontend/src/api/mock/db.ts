import type { Attachment, BotRunItem, Channel, Invite, Member, Message, ServerFrame, Team, User } from "../types";
import standupVideoUrl from "./assets/demo-standup.mp4?url";

/**
 * Mock 内存数据库（刷新即重置），数据形状与 docs/api.md 一致。
 * 不保存任何密码；会话令牌是随机 mock 串。
 */

export interface Audience {
  /** 仅发给该用户 */
  only?: string;
  /** 发给除该用户外的人 */
  except?: string;
}

export type TeamRecord = Omit<Team, "my_member_id" | "my_role">;

export interface MockDb {
  users: Map<string, User>;
  sessions: Map<string, string>;
  teams: Map<string, TeamRecord>;
  members: Member[];
  channels: Map<string, Channel>;
  messages: Message[];
  attachments: Map<string, Attachment>;
  /** 已被消息引用的附件 id（§4.3：附件只能被引用一次） */
  usedAttachments: Set<string>;
  /** 事件总线；audience 用于模拟“只发给某人 / 发给除某人外” */
  listeners: Set<(frame: ServerFrame, audience?: Audience) => void>;
  invites: Invite[];
  /** 已配置 webhook 的 bot member_id（没配的 @ 后会 bot.run.failed(no_webhook)） */
  botsWithWebhook: Set<string>;
  /** bot_id -> description（§8.1 Bot.description；资料卡展示） */
  botDescriptions: Map<string, string>;
  botRuns: BotRunItem[];
  /** client_msg_id 幂等：`${member_id}:${client_msg_id}` -> message id */
  clientMsgIds: Map<string, string>;
  /** 按用户的频道状态（§5.7）：`${user_id}:${channel_id}` -> 已读位置 / 置顶时间 */
  channelState: Map<string, { last_read_seq: number; pinned_at: string | null }>;
  /** 成员加入时的最新 seq（加入前的消息视为已读）：member_id -> seq */
  joinSeq: Map<string, number>;
  /** 服务器是否配置了推送（§9.4 / §13）；mock 可用 localStorage teams.mock.push=off 关掉 */
  pushEnabled: boolean;
  /** 测试用：GET /skill 返回 503 skill_unavailable */
  skillUnavailable?: boolean;
  vapidPublicKey: string;
  /** endpoint -> 订阅 */
  pushSubscriptions: Map<string, { id: string; user_id: string; endpoint: string; created_at: string; updated_at: string }>;
  seq: number;
  idCounter: number;
}

/** 生成 UUID 形状的 mock id */
export function mockUuid(n: number): string {
  return `0193a000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
}

export function nextId(db: MockDb): string {
  db.idCounter += 1;
  return mockUuid(db.idCounter);
}

export function nextSeq(db: MockDb): number {
  db.seq += 1;
  return db.seq;
}

export function emit(db: MockDb, frame: ServerFrame, audience?: Audience): void {
  const full = { id: `evt_${nextId(db).slice(-8)}`, ts: new Date().toISOString(), ...frame } as ServerFrame;
  db.listeners.forEach((l) => l(full, audience));
}

export function senderOf(m: Member): Message["sender"] {
  return {
    member_id: m.id,
    type: m.type,
    display_name: m.display_name,
    avatar_url: m.avatar_url,
    avatar_shape: m.avatar_shape,
    avatar_color: m.avatar_color,
  };
}

function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export function demoImage(title: string, from: string, to: string): string {
  return svgDataUrl(
    `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="270" viewBox="0 0 480 270">` +
      `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs>` +
      `<rect width="480" height="270" rx="16" fill="url(#g)"/>` +
      `<circle cx="380" cy="70" r="36" fill="#ffffff" opacity="0.35"/>` +
      `<path d="M0 230 L120 140 L210 210 L300 120 L480 250 L480 270 L0 270 Z" fill="#000" opacity="0.25"/>` +
      `<text x="28" y="54" font-family="system-ui, sans-serif" font-size="26" font-weight="700" fill="#fff">${title}</text>` +
      `</svg>`,
  );
}

/** 模拟“后端从 Grok Bot 同步来的 bot 头像 avatar_url”（本地 data URI，不依赖外网） */
export function botAvatar(bg: string, glyph: string): string {
  return svgDataUrl(
    `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">` +
      `<rect width="128" height="128" fill="${bg}"/>` +
      `<rect x="30" y="40" width="68" height="54" rx="14" fill="#fff"/>` +
      `<circle cx="50" cy="66" r="7" fill="${bg}"/><circle cx="78" cy="66" r="7" fill="${bg}"/>` +
      `<rect x="61" y="22" width="6" height="18" fill="#fff"/><circle cx="64" cy="20" r="6" fill="#fff"/>` +
      `<text x="64" y="118" text-anchor="middle" font-family="system-ui, sans-serif" font-size="16" font-weight="700" fill="#fff">${glyph}</text>` +
      `</svg>`,
  );
}

function teamIcon(bg: string, glyph: string): string {
  return svgDataUrl(
    `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">` +
      `<rect width="96" height="96" fill="${bg}"/>` +
      `<text x="48" y="60" text-anchor="middle" font-family="system-ui, sans-serif" font-size="36" font-weight="800" fill="#fff">${glyph}</text>` +
      `</svg>`,
  );
}

export const IDS = {
  uAlice: mockUuid(1),
  uBob: mockUuid(2),
  uCarol: mockUuid(3),
  uDave: mockUuid(4),
  tDev: mockUuid(11),
  tDesign: mockUuid(12),
  tOpen: mockUuid(13),
  mCarolOpen: mockUuid(29),
  mHelperOpen: mockUuid(30),
  cOpenGeneral: mockUuid(46),
  // team 内 member_id
  mAlice: mockUuid(21),
  mBob: mockUuid(22),
  mCarol: mockUuid(23),
  mDave: mockUuid(24),
  mHelper: mockUuid(25),
  mDeploy: mockUuid(26),
  mBobDesign: mockUuid(27),
  mAliceDesign: mockUuid(28),
  bHelper: mockUuid(31),
  bDeploy: mockUuid(32),
  bPlanner: mockUuid(33),
  bStar: mockUuid(34),
  mPlanner: mockUuid(35),
  mStar: mockUuid(36),
  cGeneral: mockUuid(41),
  cFrontend: mockUuid(42),
  cBackend: mockUuid(43),
  cRandom: mockUuid(44),
  cDesignGeneral: mockUuid(45),
};

export function createMockDb(): MockDb {
  const now = Date.now();
  const iso = (minAgo: number) => new Date(now - minAgo * 60_000).toISOString();
  const week = iso(60 * 24 * 7);

  const user = (id: string, username: string, display_name: string): User => ({
    id,
    username,
    display_name,
    avatar_url: null,
    created_at: week,
  });
  const users = [
    user(IDS.uAlice, "alice", "Alice"),
    user(IDS.uBob, "bob", "Bob"),
    user(IDS.uCarol, "carol", "Carol"),
    user(IDS.uDave, "dave", "Dave"),
  ];

  const teams: TeamRecord[] = [
    {
      id: IDS.tDev,
      name: "TeAms 开发组",
      description: "前后端分离的团队聊天网站",
      icon_url: null,
      owner_user_id: IDS.uAlice,
      created_at: week,
    },
    {
      id: IDS.tDesign,
      name: "设计评审",
      description: "",
      icon_url: teamIcon("#eb459e", "设"),
      owner_user_id: IDS.uBob,
      created_at: iso(60 * 24 * 3),
    },
    {
      id: IDS.tOpen,
      name: "Open Lab",
      description: "开放实验室，凭邀请链接加入",
      icon_url: teamIcon("#23a55a", "OL"),
      owner_user_id: IDS.uCarol,
      created_at: iso(60 * 24 * 2),
    },
  ];

  const um = (id: string, teamId: string, u: User, role: Member["role"]): Member => ({
    id,
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
    joined_at: week,
  });
  const members: Member[] = [
    um(IDS.mAlice, IDS.tDev, users[0], "owner"),
    um(IDS.mBob, IDS.tDev, users[1], "admin"),
    um(IDS.mCarol, IDS.tDev, users[2], "member"),
    um(IDS.mDave, IDS.tDev, users[3], "member"),
    {
      id: IDS.mHelper,
      team_id: IDS.tDev,
      type: "bot",
      user_id: null,
      bot_id: IDS.bHelper,
      display_name: "Grok",
      username: "grok",
      // 程序化头像（优先级最高）；同时给一个 avatar_url 示例
      avatar_url: botAvatar("#6d5cf6", "AI"),
      avatar_shape: "blob",
      avatar_color: "black",
      role: "bot",
      joined_at: week,
    },
    {
      id: IDS.mDeploy,
      team_id: IDS.tDev,
      type: "bot",
      user_id: null,
      bot_id: IDS.bDeploy,
      display_name: "DeployBot",
      username: "deploybot",
      // 只有 avatar_url（模拟从 Grok Bot 同步来的头像）
      avatar_url: botAvatar("#23a55a", "CI"),
      avatar_shape: null,
      avatar_color: null,
      role: "bot",
      joined_at: week,
    },
    {
      id: IDS.mPlanner,
      team_id: IDS.tDev,
      type: "bot",
      user_id: null,
      bot_id: IDS.bPlanner,
      display_name: "Planner",
      username: "planner",
      avatar_url: null,
      avatar_shape: "capsule",
      avatar_color: "blue",
      role: "bot",
      joined_at: week,
    },
    {
      id: IDS.mStar,
      team_id: IDS.tDev,
      type: "bot",
      user_id: null,
      bot_id: IDS.bStar,
      display_name: "StarBot",
      username: "starbot",
      avatar_url: null,
      // 后端原样存储、不保证小写：演示前端 trim + 忽略大小写解析
      avatar_shape: " Star ",
      avatar_color: "VIOLET",
      role: "bot",
      joined_at: week,
    },
    um(IDS.mBobDesign, IDS.tDesign, users[1], "owner"),
    um(IDS.mAliceDesign, IDS.tDesign, users[0], "member"),
    um(IDS.mCarolOpen, IDS.tOpen, users[2], "owner"),
    {
      id: IDS.mHelperOpen,
      team_id: IDS.tOpen,
      type: "bot",
      user_id: null,
      bot_id: mockUuid(37),
      display_name: "LabBot",
      username: "labbot",
      avatar_url: null,
      avatar_shape: "flower",
      avatar_color: "green",
      role: "bot",
      joined_at: iso(60 * 24 * 2),
    },
  ];

  const ch = (id: string, teamId: string, name: string, topic: string, by: string): Channel => ({
    id,
    team_id: teamId,
    name,
    topic,
    is_default: name === "general",
    created_by_member_id: by,
    last_message_seq: 0,
    created_at: week,
  });
  const channels = [
    ch(IDS.cGeneral, IDS.tDev, "general", "日常讨论", IDS.mAlice),
    ch(IDS.cFrontend, IDS.tDev, "frontend", "前端开发", IDS.mAlice),
    ch(IDS.cBackend, IDS.tDev, "backend", "后端开发", IDS.mBob),
    ch(IDS.cRandom, IDS.tDev, "random", "", IDS.mBob),
    ch(IDS.cDesignGeneral, IDS.tDesign, "general", "", IDS.mBobDesign),
    ch(IDS.cOpenGeneral, IDS.tOpen, "general", "欢迎新成员", IDS.mCarolOpen),
  ];

  const broken: Attachment = {
    id: mockUuid(53),
    kind: "image",
    mime_type: "image/png",
    size_bytes: 4096,
    file_name: "expired-link.png",
    width: 480,
    height: 270,
    duration_ms: null,
    // 故意指向不存在的文件：演示媒体加载失败的占位和重试
    url: "/__missing__/expired-link.png?exp=1&sig=mock",
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
  };
  const img: Attachment = {
    id: mockUuid(51),
    kind: "image",
    mime_type: "image/svg+xml",
    size_bytes: 2048,
    file_name: "login-v2.svg",
    width: 480,
    height: 270,
    duration_ms: null,
    url: demoImage("登录页设计稿 v2", "#6d5cf6", "#eb459e"),
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
  };
  const video: Attachment = {
    id: mockUuid(52),
    kind: "video",
    mime_type: "video/mp4",
    size_bytes: 93_000,
    file_name: "demo-standup.mp4",
    width: 480,
    height: 270,
    duration_ms: null, // 后端目前恒为 null
    // 本地示例视频（ffmpeg testsrc 生成；随 mock 一起按需打包，生产包不含）
    url: standupVideoUrl,
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
  };

  const memberById = new Map(members.map((m) => [m.id, m]));
  let seq = 1000;
  const msg = (channelId: string, senderId: string, content: string, minAgo: number, attachments: Attachment[] = []): Message => {
    const s = memberById.get(senderId)!;
    seq += 1;
    const mentionIds = [...content.matchAll(/<@([0-9A-Za-z_-]+)>/g)].map((m) => m[1]);
    return {
      id: mockUuid(100 + seq - 1000),
      seq,
      team_id: s.team_id,
      channel_id: channelId,
      sender: senderOf(s),
      content,
      mentions: [...new Set(mentionIds)].map((id) => {
        const m = memberById.get(id)!;
        return { member_id: m.id, type: m.type, display_name: m.display_name };
      }),
      kind: "message",
      attachments,
      reply_to: null,
      trigger_depth: s.type === "bot" ? 1 : 0,
      created_at: iso(minAgo),
      edited_at: null,
      deleted: false,
    };
  };

  const messages: Message[] = [
    msg(IDS.cGeneral, IDS.mBob, "大家好，TeAms 的仓库建好了 🎉", 180),
    msg(IDS.cGeneral, IDS.mBob, "前端先用 mock 跑起来，接口按 docs/api.md 对齐", 179),
    msg(IDS.cGeneral, IDS.mDeploy, "✅ main 分支构建通过（#42），已部署到预览环境。", 120),
    msg(IDS.cGeneral, IDS.mAlice, "登录页设计稿更新了，看下👇", 45, [img]),
    msg(IDS.cGeneral, IDS.mAlice, `<@${IDS.mBob}> 有空帮忙 review 一下`, 44),
    msg(IDS.cGeneral, IDS.mBob, "今天站会录屏放这里了", 20, [video]),
    msg(IDS.cGeneral, IDS.mAlice, `<@${IDS.mHelper}> 帮我总结一下今天的讨论`, 6),
    msg(
      IDS.cGeneral,
      IDS.mHelper,
      `<@${IDS.mAlice}> 今日要点：① 仓库已建，前端先走 mock；② 登录页设计稿 v2 待 <@${IDS.mBob}> review；③ 站会录屏已上传。`,
      5,
    ),
    msg(IDS.cGeneral, IDS.mPlanner, `📋 本周排期已更新：<@${IDS.mAlice}> 负责前端联调，<@${IDS.mBob}> 负责 WS 推送。`, 4),
    msg(IDS.cGeneral, IDS.mStar, "⭐ 今日最佳：程序化 bot 头像已接入。", 3),
    msg(IDS.cFrontend, IDS.mAlice, "Discord 式四栏布局骨架已经搭好了", 30),
    msg(IDS.cRandom, IDS.mBob, "这张图的签名链接过期了（演示加载失败）", 15, [broken]),
    // —— 未读演示（§5.7）：每个用户的已读位置见下方 channelState ——
    msg(IDS.cFrontend, IDS.mBob, "frontend 的未读演示：登录页联调完了吗？", 12),
    msg(IDS.cFrontend, IDS.mDave, "我这边 Safari 上头像有点糊，晚点看看", 11),
    msg(IDS.cBackend, IDS.mBob, `<@${IDS.mAlice}> <@${IDS.mCarol}> 接口文档 §5.7 更新了，未读和置顶都有了`, 10),
    msg(IDS.cRandom, IDS.mBob, `<@${IDS.mCarol}> 周五团建去哪？`, 9),
    msg(IDS.cDesignGeneral, IDS.mBobDesign, `<@${IDS.mAliceDesign}> 新版配色出来了，帮忙看下`, 8),
    msg(IDS.cDesignGeneral, IDS.mBobDesign, "图标也换了一版", 7),
    // —— bot 声明不回复演示（§7.7）：Planner 对这条选择不回复 ——
    msg(IDS.cGeneral, IDS.mAlice, `<@${IDS.mPlanner}> 帮我订一下明天下午的会议室`, 2),
    msg(IDS.cGeneral, IDS.mPlanner, "订会议室不在我的服务范围内，请找行政", 1.9),
  ];
  // 最后一条是 Planner 的“不回复”提示：kind=bot_declined、reply_to=触发消息、mentions 为空、trigger_depth=0
  {
    const declined = messages[messages.length - 1];
    declined.kind = "bot_declined";
    declined.reply_to = messages[messages.length - 2].id;
    declined.mentions = [];
    declined.trigger_depth = 0;
  }
  for (const c of channels) {
    c.last_message_seq = Math.max(0, ...messages.filter((m) => m.channel_id === c.id).map((m) => m.seq));
  }
  // 成员描述（§3）：bot 是描述，用户恒为 null
  const descriptions = new Map<string, string>([
    [IDS.bHelper, "团队里的 AI 助手：@Grok 提问、总结讨论、写代码片段。"],
    [IDS.bDeploy, "部署机器人：@DeployBot 部署 staging（未配置 webhook，演示失败提示）。"],
    [IDS.bPlanner, "每周一同步排期和待办；不在服务范围内的请求会声明不回复（消息里带 [decline] 也会触发）。"],
    [IDS.bStar, ""],
  ]);
  for (const m of members) m.description = m.type === "bot" ? (descriptions.get(m.bot_id ?? "") ?? "") : null;

  // 已读位置：默认视为加入时全部已读（迁移把 join_seq 设为当时最大 seq），只保留下面这些“未读演示”
  const seqOf = (i: number) => messages[i].seq;
  const idxOf = (content: string) => messages.findIndex((m) => m.content.startsWith(content));
  const baseSeq = seqOf(idxOf("frontend 的未读演示")) - 1;
  const joinSeq = new Map(members.map((m) => [m.id, baseSeq]));
  const channelState = new Map<string, { last_read_seq: number; pinned_at: string | null }>();
  // Alice 已经看过 general 里的全部（含 Planner 的不回复提示），frontend / backend / 设计评审 有未读；置顶 backend
  channelState.set(`${IDS.uAlice}:${IDS.cGeneral}`, { last_read_seq: seq, pinned_at: null });
  channelState.set(`${IDS.uAlice}:${IDS.cBackend}`, { last_read_seq: baseSeq, pinned_at: iso(60) });
  // Carol 看过 general，其余未读（random 有 @ 她）
  channelState.set(`${IDS.uCarol}:${IDS.cGeneral}`, { last_read_seq: seq, pinned_at: null });

  const inv = (
    n: number,
    code: string,
    teamId: string,
    createdBy: string,
    extra: Partial<Invite>,
  ): Invite => ({
    id: mockUuid(n),
    code,
    team_id: teamId,
    url_path: `/invite/${code}`,
    expires_at: null,
    max_uses: null,
    uses: 0,
    revoked_at: null,
    created_by: createdBy,
    created_at: iso(60 * 24),
    ...extra,
  });
  const inFuture = (min: number) => new Date(now + min * 60_000).toISOString();
  // 演示用邀请：有效 / 过期 / 作废 / 次数用尽
  const invites: Invite[] = [
    inv(61, "OpenLab8", IDS.tOpen, IDS.mCarolOpen, { uses: 3 }),
    inv(62, "Expired1", IDS.tOpen, IDS.mCarolOpen, { expires_at: iso(30) }),
    inv(63, "Revoked1", IDS.tOpen, IDS.mCarolOpen, { revoked_at: iso(60) }),
    inv(64, "UsedUp01", IDS.tOpen, IDS.mCarolOpen, { max_uses: 1, uses: 1 }),
    inv(65, "DevTeam7", IDS.tDev, IDS.mAlice, { expires_at: inFuture(7 * 24 * 60 - 90), max_uses: 10, uses: 2 }),
    inv(66, "DevOld01", IDS.tDev, IDS.mAlice, { revoked_at: iso(120), created_at: iso(60 * 24 * 3) }),
  ];

  return {
    invites,
    users: new Map(users.map((u) => [u.id, u])),
    sessions: new Map(),
    teams: new Map(teams.map((t) => [t.id, t])),
    members,
    channels: new Map(channels.map((c) => [c.id, c])),
    messages,
    attachments: new Map([
      [img.id, img],
      [video.id, video],
      [broken.id, broken],
    ]),
    usedAttachments: new Set([img.id, video.id, broken.id]),
    botsWithWebhook: new Set([IDS.mHelper, IDS.mPlanner, IDS.mStar, IDS.mHelperOpen]),
    botDescriptions: new Map([
      [IDS.bHelper, "团队里的 AI 助手：@Grok 提问、总结讨论、写代码片段。"],
      [IDS.bDeploy, "部署机器人：@DeployBot 部署 staging（未配置 webhook，演示失败提示）。"],
      [IDS.bPlanner, "每周一同步排期和待办。"],
      [IDS.bStar, ""],
    ]),
    botRuns: [],
    listeners: new Set(),
    clientMsgIds: new Map(),
    channelState,
    joinSeq,
    pushEnabled: !(typeof localStorage !== "undefined" && localStorage.getItem("teams.mock.push") === "off"),
    // mock 的 VAPID 公钥：格式正确（65 字节 P-256 未压缩点，base64url），不是真钥匙
    vapidPublicKey: "BM6pRJ2c1a9V0k0bS1vZ1Qy0bH3Kq2f3sJp7xg4mXh0Yb3sM0kq8Y1cHq3n0b7rA5cM2vX3pYk9wL2tR8jE6uQ0",
    pushSubscriptions: new Map(),
    seq,
    idCounter: 1000,
  };
}
