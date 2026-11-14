import { Link, useNavigate } from "react-router";
import { useAuth, useToken } from "../auth/AuthContext";
import { CreateTeamForm } from "../components/TeamForms";
import { TeamRail } from "../components/TeamRail";
import { initials } from "../components/MemberAvatar";
import { useTeams } from "../hooks";
import { LogoWordmark } from "../components/Logo";

/** Team 列表 + 创建 / 加入 */
export default function TeamsPage() {
  const token = useToken();
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const { teams, reload } = useTeams(token);

  return (
    <div className="flex h-full bg-[#313338] text-[#dbdee1]">
      <TeamRail teams={teams} onAdd={() => document.getElementById("team-forms")?.scrollIntoView({ behavior: "smooth" })} />
      <main className="flex-1 overflow-y-auto p-8">
        <div className="mx-auto max-w-4xl">
          <div className="mb-6 flex items-center justify-between">
            <div className="flex items-center gap-4">
              <LogoWordmark size={36} />
              <h1 className="text-2xl font-bold text-white">你好，{user?.display_name}</h1>
            </div>
            <button type="button" onClick={() => void logout()} className="text-sm text-[#b5bac1] hover:text-white">
              退出登录
            </button>
          </div>
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-[#949ba4]">我的 Team — {teams.length}</h2>
          <div className="mb-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {teams.map((t) => (
              <Link
                key={t.id}
                to={`/teams/${t.id}`}
                className="flex items-center gap-3 rounded-lg bg-[#2b2d31] p-4 hover:bg-[#35373c]"
              >
                <span className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-2xl bg-[#5865f2] font-semibold text-white">
                  {t.icon_url ? <img src={t.icon_url} alt="" className="h-full w-full object-cover" /> : initials(t.name)}
                </span>
                <span className="min-w-0">
                  <span className="block truncate font-semibold text-white">{t.name}</span>
                  <span className="block truncate text-xs text-[#949ba4]">{t.description || `我的角色：${t.my_role}`}</span>
                </span>
              </Link>
            ))}
            {teams.length === 0 ? <p className="text-sm text-[#949ba4]">还没有加入任何 Team。可以自己创建，或让管理员按你的用户名添加你。</p> : null}
          </div>
          <div id="team-forms" className="max-w-lg">
            <CreateTeamForm
              token={token}
              onDone={async (team) => {
                await reload();
                navigate(`/teams/${team.id}`);
              }}
            />
          </div>
        </div>
      </main>
    </div>
  );
}
