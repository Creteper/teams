import type { Message } from "../api/types";

/** 连续消息合并：同一发送者、间隔 ≤ 5 分钟归为一组 */
export function groupMessages(messages: Message[], windowMs = 5 * 60_000): Message[][] {
  const groups: Message[][] = [];
  for (const msg of messages) {
    const last = groups[groups.length - 1];
    const prev = last?.[last.length - 1];
    if (
      prev &&
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
  for (const m of incoming) map.set(m.id, m);
  return [...map.values()].sort((a, b) => a.seq - b.seq);
}

export function formatTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const hm = d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === now.toDateString()) return `今天 ${hm}`;
  return `${d.toLocaleDateString("zh-CN")} ${hm}`;
}
