import type { Message } from "../api/types";

export const isDeclined = (m: Pick<Message, "kind">) => m.kind === "bot_declined";

/**
 * bot 声明不回复的提示（kind=bot_declined，§7.7）挂到 reply_to 指向的触发消息下面：
 * 返回 { main, byTrigger }——触发消息已加载的提示放进 byTrigger，不在 main 里单独成行；
 * 触发消息没加载到（更早的分页）或 reply_to 为空的，留在 main 里按原位置显示。
 */
export function attachDeclines(messages: Message[]): { main: Message[]; byTrigger: Map<string, Message[]> } {
  const ids = new Set(messages.filter((m) => !isDeclined(m)).map((m) => m.id));
  const byTrigger = new Map<string, Message[]>();
  const main: Message[] = [];
  for (const m of messages) {
    if (isDeclined(m) && m.reply_to && ids.has(m.reply_to)) {
      const list = byTrigger.get(m.reply_to) ?? [];
      list.push(m);
      byTrigger.set(m.reply_to, list);
    } else main.push(m);
  }
  return { main, byTrigger };
}

/** 连续消息合并：同一发送者、间隔 ≤ 5 分钟归为一组；bot_declined 提示不和普通消息合并 */
export function groupMessages(messages: Message[], windowMs = 5 * 60_000): Message[][] {
  const groups: Message[][] = [];
  for (const msg of messages) {
    const last = groups[groups.length - 1];
    const prev = last?.[last.length - 1];
    if (
      prev &&
      !isDeclined(prev) &&
      !isDeclined(msg) &&
      prev.sender.member_id === msg.sender.member_id &&
      Date.parse(msg.created_at) - Date.parse(prev.created_at) <= windowMs
    ) {
      last.push(msg);
    } else {
      groups.push([msg]);
    }
  }
  return groups;
}

/** 按 seq 合并去重并保持正序 */
export function mergeMessages(prev: Message[], incoming: Message[]): Message[] {
  const map = new Map(prev.map((m) => [m.id, m]));
  for (const m of incoming) {
    const existing = map.get(m.id);
    if (m.qa_card && (existing?.deleted || (existing?.qa_card?.revision ?? -1) > m.qa_card.revision)) continue;
    map.set(m.id, m);
  }
  return [...map.values()].sort((a, b) => a.seq - b.seq);
}

export function formatTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const hm = d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === now.toDateString()) return `今天 ${hm}`;
  return `${d.toLocaleDateString("zh-CN")} ${hm}`;
}
