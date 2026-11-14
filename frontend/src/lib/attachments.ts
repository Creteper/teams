import type { AttachmentUrl, Message } from "../api/types";

/** 签名 URL 有效期 1 小时（docs/api.md §5）；没有 exp 参数时按加载时间 + 1h 估算 */
export const SIGNED_URL_TTL_MS = 3600_000;

/** 从签名 URL 的 `exp`（Unix 秒）读到期时间；读不到返回 null */
export function urlExpiry(url: string): number | null {
  const q = url.indexOf("?");
  if (q < 0) return null;
  const exp = new URLSearchParams(url.slice(q + 1)).get("exp");
  const n = exp ? Number(exp) : NaN;
  return Number.isFinite(n) && n > 0 ? n * 1000 : null;
}

/**
 * 找出即将过期（now + marginMs 之前到期）的附件 id。
 * expiries：已知到期时间（刷新接口返回的 expires_at，或首次见到时的估算）。
 */
export function idsNeedingRefresh(
  messages: Message[],
  expiries: Map<string, number>,
  now: number,
  marginMs = 5 * 60_000,
): string[] {
  const ids: string[] = [];
  for (const m of messages) {
    for (const a of m.attachments) {
      if (a.url.startsWith("data:") || a.url.startsWith("blob:")) continue;
      const exp = expiries.get(a.id) ?? urlExpiry(a.url);
      if (exp !== null && exp !== undefined && exp - now <= marginMs && !ids.includes(a.id)) ids.push(a.id);
    }
  }
  return ids;
}

/** 把刷新后的 URL 应用到消息列表（无变化时返回原数组，避免无谓渲染） */
export function applyAttachmentUrls(messages: Message[], updates: AttachmentUrl[]): Message[] {
  if (updates.length === 0) return messages;
  const byId = new Map(updates.map((u) => [u.id, u.url]));
  let changed = false;
  const next = messages.map((m) => {
    if (!m.attachments.some((a) => byId.has(a.id) && byId.get(a.id) !== a.url)) return m;
    changed = true;
    return { ...m, attachments: m.attachments.map((a) => (byId.has(a.id) ? { ...a, url: byId.get(a.id)! } : a)) };
  });
  return changed ? next : messages;
}

export function chunk<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}
