import { Link } from "react-router";
import type { Team } from "../api/types";
import { initials } from "./MemberAvatar";

/** 最左侧竖排 team 图标栏（圆形图标，选中为圆角方块 + 左侧指示条） */
export function TeamRail({ teams, currentTeamId, onAdd }: { teams: Team[]; currentTeamId?: string; onAdd(): void }) {
  return (
    <nav aria-label="Teams" className="flex w-[72px] shrink-0 flex-col items-center gap-2 overflow-y-auto bg-[#1e1f22] py-3">
      <Link
        to="/teams"
        title="TeAms"
        className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[#5865f2] text-sm font-black tracking-tight text-white"
      >
        TA
      </Link>
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
            <Link
              to={`/teams/${t.id}`}
              title={t.name}
              aria-current={active ? "page" : undefined}
              className={`flex h-12 w-12 items-center justify-center overflow-hidden text-sm font-semibold text-white transition-all ${
                active ? "rounded-2xl bg-[#5865f2]" : "rounded-full bg-[#313338] hover:rounded-2xl hover:bg-[#5865f2]"
              }`}
            >
              {/* icon_url 可能为空 → 默认首字母图标 */}
              {t.icon_url ? <img src={t.icon_url} alt={t.name} className="h-full w-full object-cover" /> : initials(t.name)}
            </Link>
          </div>
        );
      })}
      <button
        type="button"
        onClick={onAdd}
        title="创建 Team"
        aria-label="创建 Team"
        className="flex h-12 w-12 items-center justify-center rounded-full bg-[#313338] text-2xl text-[#23a55a] transition-all hover:rounded-2xl hover:bg-[#23a55a] hover:text-white"
      >
        +
      </button>
    </nav>
  );
}
