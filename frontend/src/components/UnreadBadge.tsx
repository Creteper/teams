import { unreadLabel } from "../lib/unread";

/**
 * 未读徽标：普通未读是灰底数字；有 @ 我的未读是红底「@ 数字」（更醒目）。
 * 数字到上限（1000）显示 999+（§5.7）；只有 @ 但计数为 0 时只显示「@」。
 */
export function UnreadBadge({ count, mention, className = "" }: { count: number; mention: boolean; className?: string }) {
  const label = unreadLabel(count);
  if (!label && !mention) return null;
  return (
    <span
      data-testid="unread-badge"
      data-mention={mention ? "true" : undefined}
      aria-hidden="true"
      className={`ml-1 inline-flex h-4 min-w-4 shrink-0 items-center justify-center gap-0.5 rounded-full px-1.5 text-[11px] font-bold leading-none tabular-nums ${
        mention ? "bg-[#f23f43] text-white" : "bg-[#4e5058] text-[#f2f3f5]"
      } ${className}`}
    >
      {mention ? <span>@</span> : null}
      {label ? <span>{label}</span> : null}
    </span>
  );
}
