import { Badge } from "@heroui/react";
import { unreadLabel } from "../lib/unread";

/**
 * 未读徽标（HeroUI Badge，行内摆放）：普通未读是灰底数字；有 @ 我的未读是红底「@ 数字」（更醒目）。
 * 数字到上限（1000）显示 999+（§5.7）；只有 @ 但计数为 0 时只显示「@」。
 */
export function UnreadBadge({ count, mention, className = "" }: { count: number; mention: boolean; className?: string }) {
  const label = unreadLabel(count);
  if (!label && !mention) return null;
  return (
    <Badge
      data-testid="unread-badge"
      data-mention={mention ? "true" : undefined}
      aria-hidden="true"
      className={`static ml-1 h-4 min-h-4 min-w-4 transform-none gap-0.5 rounded-full border-0 px-1.5 text-[11px] leading-none font-bold tabular-nums ${
        mention ? "[--badge-bg:#f23f43] [--badge-fg:#fff]" : "[--badge-bg:#4e5058] [--badge-fg:#f2f3f5]"
      } ${className}`}
    >
      {mention ? <span>@</span> : null}
      {label ? <span>{label}</span> : null}
    </Badge>
  );
}
