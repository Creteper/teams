import type { Attachment, Message } from "../api/types";

/** 找出即将过期（now + marginMs 之前到期，按附件的 expires_at）的附件 id；跳过本地 data:/blob: */
export function idsNeedingRefresh(messages: Message[], now: number, marginMs = 5 * 60_000): string[] {
  const ids = new Set<string>();
  for (const m of messages) {
    for (const a of m.attachments) {
      if (a.url.startsWith("data:") || a.url.startsWith("blob:")) continue;
      const exp = Date.parse(a.expires_at);
      if (Number.isFinite(exp) && exp - now <= marginMs) ids.add(a.id);
    }
  }
  return [...ids];
}

/** 把刷新后的附件（新 url + expires_at）应用到消息列表（无变化时返回原数组） */
export function applyAttachmentUrls(messages: Message[], updates: Pick<Attachment, "id" | "url" | "expires_at">[]): Message[] {
  if (updates.length === 0) return messages;
  const byId = new Map(updates.map((u) => [u.id, u]));
  let changed = false;
  const next = messages.map((m) => {
    if (!m.attachments.some((a) => byId.has(a.id) && (byId.get(a.id)!.url !== a.url || byId.get(a.id)!.expires_at !== a.expires_at)))
      return m;
    changed = true;
    return {
      ...m,
      attachments: m.attachments.map((a) => {
        const u = byId.get(a.id);
        return u ? { ...a, url: u.url, expires_at: u.expires_at } : a;
      }),
    };
  });
  return changed ? next : messages;
}

export function chunk<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}
