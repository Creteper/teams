import type { Attachment, MessageSender } from "../api/types";

/** 本地待发送 / 发送失败的消息（发送只走 REST，失败可重发或删除） */
export interface OutboxItem {
  local_id: string;
  channel_id: string;
  /** 线上格式正文（含 <@member_id>） */
  content: string;
  attachments: Attachment[];
  /** 重发时沿用同一个，后端幂等 */
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
