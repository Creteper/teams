import { Link } from "react-router";
import type { Team } from "../api/types";
import { Logo } from "./Logo";
import { TeamIcon } from "./TeamIcon";
import { RailTooltip } from "./ui";
import { unreadLabel, type TeamUnread } from "../lib/unread";

/**
 * 最左侧竖排 team 图标栏：顶部 LOGO 主页按钮，选中 team 有指示条，hover 显示全名。
 * 未读汇总（GET /me/unread + 实时累加，§5.7）：其他 team 有未读 → 左侧白色小圆点 + 右下角灰色数字；有 @ 我 → 红色「@数字」徽标。
 */
export function TeamRail({
  teams,
  currentTeamId,
  onAdd,
  unread = {},
}: {
  teams: Team[];
  currentTeamId?: string;
  onAdd(): void;
  unread?: Record<string, TeamUnread>;
}) {
  return (
    <nav aria-label="Teams" className="flex w-[72px] shrink-0 flex-col items-center gap-2 bg-[#1e1f22] py-3">
      {/* 主页按钮：点击回到 team 列表 */}
      <div className="group relative flex w-full justify-center">
        <span className="absolute left-0 top-1/2 h-0 w-1 -translate-y-1/2 rounded-r bg-white transition-all group-hover:h-5" />
        <Link to="/teams" aria-label="TeAms 主页（我的 Team）">
          <Logo size={48} className="transition-transform group-hover:scale-105" />
        </Link>
        <RailTooltip text="我的 Team" />
      </div>
      <div className="h-[2px] w-8 rounded bg-[#35363c]" />
      {teams.map((t) => {
        const active = t.id === currentTeamId;
        // 当前 team 的未读在频道列表里看，图标上不重复显示
        const u = active ? undefined : unread[t.id];
        const hasUnread = !!u && (u.count > 0 || u.mention);
        const label = u ? unreadLabel(u.count) : null;
        return (
          <div key={t.id} className="group relative flex w-full justify-center" data-team-id={t.id} data-unread={hasUnread ? (u!.mention ? "mention" : "true") : undefined}>
            <span
              className={`absolute left-0 top-1/2 w-1 -translate-y-1/2 rounded-r bg-white transition-all ${
                active ? "h-10" : hasUnread ? "h-2 group-hover:h-5" : "h-0 group-hover:h-5"
              }`}
            />
            <Link
              to={`/teams/${t.id}`}
              aria-label={`${t.name}${hasUnread ? (u!.mention ? `，有人 @ 你，${label ?? ""} 条未读` : `，${label ?? ""} 条未读`) : ""}`}
              aria-current={active ? "page" : undefined}
              className="relative"
            >
              <TeamIcon
                team={t}
                size={48}
                className={`transition-all duration-150 ${active ? "rounded-2xl" : "rounded-[24px] group-hover:rounded-2xl"}`}
              />
              {hasUnread && (u!.mention || label) ? (
                <span
                  data-testid="team-unread-badge"
                  data-mention={u!.mention ? "true" : undefined}
                  aria-hidden="true"
                  className={`absolute -bottom-1 -right-1 inline-flex h-[18px] min-w-[18px] items-center justify-center gap-px rounded-full px-1 text-[11px] font-bold leading-none ring-[3px] ring-[#1e1f22] tabular-nums ${
                    u!.mention ? "bg-[#f23f43] text-white" : "bg-[#4e5058] text-[#f2f3f5]"
                  }`}
                >
                  {u!.mention ? "@" : ""}
                  {label ?? ""}
                </span>
              ) : null}
            </Link>
            <RailTooltip text={t.name} />
          </div>
        );
      })}
      <div className="group relative flex w-full justify-center">
        <button
          type="button"
          onClick={onAdd}
          aria-label="创建 Team"
          className="flex h-12 w-12 items-center justify-center rounded-[24px] bg-[#313338] text-2xl text-[#23a55a] transition-all hover:rounded-2xl hover:bg-[#23a55a] hover:text-white"
        >
          +
        </button>
        <RailTooltip text="创建 Team" />
      </div>
    </nav>
  );
}
