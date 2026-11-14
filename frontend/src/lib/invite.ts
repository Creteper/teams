import type { Invite, InviteInvalidReason } from "../api/types";

export type InviteStatus = "active" | InviteInvalidReason;

/** 邀请状态：作废 > 过期 > 次数用尽 > 有效 */
export function inviteStatus(
  invite: Pick<Invite, "revoked_at" | "expires_at" | "max_uses" | "uses">,
  now: number = Date.now(),
): InviteStatus {
  if (invite.revoked_at) return "revoked";
  if (invite.expires_at && Date.parse(invite.expires_at) <= now) return "expired";
  if (invite.max_uses !== null && invite.uses >= invite.max_uses) return "exhausted";
  return "active";
}

export const INVITE_STATUS_TEXT: Record<InviteStatus, string> = {
  active: "有效",
  expired: "已过期",
  revoked: "已作废",
  exhausted: "次数已用完",
};

/** 落地页的失效说明 */
export const INVITE_REASON_HINT: Record<InviteInvalidReason | "not_found", string> = {
  expired: "这个邀请链接已经过期了，请向管理员要一个新链接。",
  revoked: "这个邀请链接已被管理员作废。",
  exhausted: "这个邀请链接的使用次数已经用完了。",
  not_found: "邀请链接不存在，请检查链接是否完整。",
};

/** accept 接口 410 错误码 → 原因 */
export function reasonFromErrorCode(code: string): InviteInvalidReason | "not_found" | null {
  switch (code) {
    case "invite_expired":
      return "expired";
    case "invite_revoked":
      return "revoked";
    case "invite_exhausted":
      return "exhausted";
    case "invite_not_found":
      return "not_found";
    default:
      return null;
  }
}

export const EXPIRY_OPTIONS: { label: string; seconds: number | null }[] = [
  { label: "30 分钟", seconds: 30 * 60 },
  { label: "1 天", seconds: 86_400 },
  { label: "7 天", seconds: 7 * 86_400 },
  { label: "30 天", seconds: 30 * 86_400 },
  { label: "永久", seconds: null },
];

export const MAX_USES_OPTIONS: { label: string; value: number | null }[] = [
  { label: "不限", value: null },
  { label: "1 次", value: 1 },
  { label: "5 次", value: 5 },
  { label: "10 次", value: 10 },
  { label: "25 次", value: 25 },
  { label: "100 次", value: 100 },
];

export function inviteUrl(invite: Pick<Invite, "url_path">, origin: string): string {
  return `${origin}${invite.url_path}`;
}

/**
 * 校验 ?redirect= 参数，防止开放重定向：只接受站内以单个 "/" 开头的路径。
 * 拒绝 `//evil.com`、`/\evil.com`、`http://…`、`javascript:`、含控制字符等。
 */
export function safeRedirect(raw: string | null | undefined, fallback = "/teams"): string {
  if (!raw) return fallback;
  const v = raw.trim();
  if (!v.startsWith("/")) return fallback;
  if (v.startsWith("//") || v.startsWith("/\\")) return fallback;
  if (/[\u0000-\u001f\u007f\\]/.test(v)) return fallback;
  try {
    // 用一个哑 origin 解析，确认不会跳出站点
    const u = new URL(v, "https://teams.invalid");
    if (u.origin !== "https://teams.invalid") return fallback;
    return u.pathname + u.search + u.hash;
  } catch {
    return fallback;
  }
}

export function withRedirect(path: "/login" | "/register", target: string): string {
  return `${path}?redirect=${encodeURIComponent(target)}`;
}
