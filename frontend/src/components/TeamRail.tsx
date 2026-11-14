import { Link } from "react-router";
import type { Team } from "../api/types";
import { Logo } from "./Logo";
import { TeamIcon } from "./TeamIcon";
import { RailTooltip } from "./ui";

/** 最左侧竖排 team 图标栏：顶部 LOGO 主页按钮，选中 team 有指示条，hover 显示全名 */
export function TeamRail({ teams, currentTeamId, onAdd }: { teams: Team[]; currentTeamId?: string; onAdd(): void }) {
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
        return (
          <div key={t.id} className="group relative flex w-full justify-center">
            <span
              className={`absolute left-0 top-1/2 w-1 -translate-y-1/2 rounded-r bg-white transition-all ${
                active ? "h-10" : "h-0 group-hover:h-5"
              }`}
            />
            <Link to={`/teams/${t.id}`} aria-label={t.name} aria-current={active ? "page" : undefined}>
              <TeamIcon
                team={t}
                size={48}
                className={`transition-all duration-150 ${active ? "rounded-2xl" : "rounded-[24px] group-hover:rounded-2xl"}`}
              />
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
