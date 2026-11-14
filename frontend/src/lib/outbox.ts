import type { Attachment, Message, MessageSender } from "../api/types";

/**
 * 乐观发送（发送只走 REST，docs/api.md §5.4）。
 *
 * 一条消息从点「发送」开始就有一个本地 key（local_id），整个生命周期里 React key 都用它：
 * - 发送中 / 失败：列表末尾显示 outbox 里的条目（伪 Message，seq = Infinity）；
 * - 成功（HTTP 响应或 WebSocket 推送，谁先到算谁）：把真实消息并入 messages，并记下 keyOf[消息 id] = local_id，
 *   同一次渲染里把 outbox 条目移除——同一个 key 的行原地更新成真实数据，不卸载、不重建、不重播淡入动画；
 * - 只有按 seq 排序后位置变了（期间别人发了 seq 更大的消息先显示）才会挪位置（React 按 key 移动 DOM 节点）。
 *
 * 文档里 Message 对象 / message.created 不回传 client_msg_id，所以 WebSocket 先到时只能按
 * 「我发的 + 同一频道 + 正文完全相同 + 附件 id 集合相同」匹配 outbox 里最早的一条（发送中或失败的都算）。
 */
export interface OutboxItem {
  local_id: string;
  channel_id: string;
  /** 线上格式正文（含 <@member_id>） */
  content: string;
  attachments: Attachment[];
  /** 重发时沿用同一个，后端幂等（同一发送者同频道 24 小时内重复提交返回原消息） */
  client_msg_id: string;
  status: "sending" | "failed";
  error?: string;
  created_at: string;
  sender: MessageSender;
  /** 被 @ 的 bot（发送成功后用于乐观显示处理中） */
  bot_member_ids: string[];
}

export function newClientMsgId(): string {
  return `c-${crypto.randomUUID()}`;
}

export interface SendState {
  outbox: OutboxItem[];
  /** 真实消息 id → 发送时的本地 key（React key 不变） */
  keyOf: Record<string, string>;
}

export const emptySendState: SendState = { outbox: [], keyOf: {} };

export type SendAction =
  | { type: "enqueue"; item: OutboxItem }
  | { type: "sending"; local_id: string }
  | { type: "failed"; local_id: string; error: string }
  | { type: "discard"; local_id: string }
  /** HTTP 成功；alreadyShown = 这条消息已经以自己的 id 显示（例如 WebSocket 先到但没匹配上） */
  | { type: "sent"; local_id: string; message: Message; alreadyShown?: boolean }
  /** WebSocket 推来一条我发的消息：匹配到 outbox 就认领 */
  | { type: "echo"; message: Message; myMemberId: string }
  | { type: "leaveChannel"; channel_id: string };

const sameIds = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join() === [...b].sort().join();

/** WebSocket 推送的消息对应 outbox 里的哪一条（没有 client_msg_id 回传，按内容匹配最早的一条） */
export function matchOutbox(outbox: OutboxItem[], m: Message, myMemberId: string): OutboxItem | undefined {
  if (!myMemberId || m.sender.member_id !== myMemberId || (m.kind ?? "message") !== "message") return undefined;
  return outbox.find(
    (o) =>
      o.channel_id === m.channel_id &&
      o.content === m.content &&
      sameIds(
        o.attachments.map((a) => a.id),
        m.attachments.map((a) => a.id),
      ),
  );
}

export function sendReducer(s: SendState, a: SendAction): SendState {
  switch (a.type) {
    case "enqueue":
      return { ...s, outbox: [...s.outbox, a.item] };
    case "sending":
    case "failed": {
      // 已经确认（WebSocket 先到并认领）的条目不在 outbox 里了：迟到的失败直接忽略
      if (!s.outbox.some((o) => o.local_id === a.local_id)) return s;
      return {
        ...s,
        outbox: s.outbox.map((o) =>
          o.local_id === a.local_id ? (a.type === "sending" ? { ...o, status: "sending", error: undefined } : { ...o, status: "failed", error: a.error }) : o,
        ),
      };
    }
    case "discard":
      return { ...s, outbox: s.outbox.filter((o) => o.local_id !== a.local_id) };
    case "sent": {
      const outbox = s.outbox.filter((o) => o.local_id !== a.local_id);
      // 已被 WebSocket 认领（keyOf 里有）或已按自己的 id 显示：只移除 outbox，不改 key，避免重复 / 重复 key
      if (s.keyOf[a.message.id] || a.alreadyShown) return outbox.length === s.outbox.length ? s : { ...s, outbox };
      return { outbox, keyOf: { ...s.keyOf, [a.message.id]: a.local_id } };
    }
    case "echo": {
      if (s.keyOf[a.message.id]) return s;
      const hit = matchOutbox(s.outbox, a.message, a.myMemberId);
      if (!hit) return s;
      return { outbox: s.outbox.filter((o) => o !== hit), keyOf: { ...s.keyOf, [a.message.id]: hit.local_id } };
    }
    case "leaveChannel":
      // 切频道：只保留失败的（用户还要决定重发或删除）和当前频道的
      return { ...s, outbox: s.outbox.filter((o) => o.status === "failed" || o.channel_id === a.channel_id) };
  }
}

/** outbox 条目 → 伪 Message（排在所有真实消息之后；seq = Infinity 表示还没有服务端序号） */
export function outboxAsMessage(o: OutboxItem): Message {
  return {
    id: o.local_id,
    seq: Number.POSITIVE_INFINITY,
    kind: "message",
    team_id: "",
    channel_id: o.channel_id,
    sender: o.sender,
    content: o.content,
    mentions: [],
    attachments: o.attachments,
    reply_to: null,
    trigger_depth: 0,
    created_at: o.created_at,
    edited_at: null,
    deleted: false,
  };
}
