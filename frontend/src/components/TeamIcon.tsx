import { initials } from "./MemberAvatar";

const TEAM_PALETTE = ["#6d5cf6", "#e0569b", "#2fa66b", "#d98a1f", "#3f8fe0", "#1aa39a", "#9b59d6", "#d9534f"];

/** 由 team id 决定的固定颜色（各处一致） */
export function teamColor(teamId: string): string {
  let h = 0;
  for (const ch of teamId) h = (h * 33 + ch.charCodeAt(0)) >>> 0;
  return TEAM_PALETTE[h % TEAM_PALETTE.length];
}

/** team 首字母：中文取首字，英文取单词首字母（最多 2 个） */
export function teamInitials(name: string): string {
  const t = name.trim();
  if (!t) return "?";
  const first = Array.from(t)[0];
  if (/[\u4e00-\u9fff]/.test(first)) return first;
  return initials(t.replace(/[\u4e00-\u9fff]/g, " ").trim() || t);
}

/** team 图标：有 icon_url 用图，否则按 team id 取色 + 首字母。形状由外层 className 控制 */
export function TeamIcon({
  team,
  size = 48,
  className = "rounded-2xl",
}: {
  team: { id: string; name: string; icon_url: string | null };
  size?: number;
  className?: string;
}) {
  return (
    <span
      className={`flex shrink-0 items-center justify-center overflow-hidden font-semibold text-white ${className}`}
      style={{ width: size, height: size, backgroundColor: team.icon_url ? undefined : teamColor(team.id), fontSize: Math.round(size * 0.36) }}
    >
      {team.icon_url ? <img src={team.icon_url} alt="" className="h-full w-full object-cover" /> : teamInitials(team.name)}
    </span>
  );
}
