import { Button } from "@heroui/react";
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { useAuth, useToken } from "../auth/AuthContext";
import { CreateTeamForm, JoinByInviteForm, TeamDialog } from "../components/TeamForms";
import { TeamRail } from "../components/TeamRail";
import { TeamIcon } from "../components/TeamIcon";
import { useTeams } from "../hooks";
import { LogoWordmark } from "../components/Logo";
import { GearIcon } from "../components/ui";
import { MemberAvatar } from "../components/MemberAvatar";
import { roleLabel } from "../lib/roles";
import { SettingsDialog } from "../components/settings/SettingsDialog";

/** Team 列表 + 创建 + 通过邀请链接加入 */
export default function TeamsPage() {
  const token = useToken();
  const { user } = useAuth();
  const navigate = useNavigate();
  const { teams, loading, reload } = useTeams(token);
  const [dialog, setDialog] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const onCreated = async (team: { id: string }) => {
    await reload();
    navigate(`/teams/${team.id}`);
  };

  return (
    <div className="flex h-full bg-[#313338] text-[#dbdee1]">
      <TeamRail teams={teams} onAdd={() => setDialog(true)} />
      <main className="flex-1 overflow-y-auto p-8">
        <div className="mx-auto max-w-4xl">
          <div className="mb-8 flex items-center justify-between">
            <div className="flex items-center gap-4">
              <LogoWordmark size={36} />
              <span className="h-6 w-px bg-white/10" />
              <h1 className="text-xl font-bold text-white">你好，{user?.display_name}</h1>
            </div>
            {/* 用户设置唯一入口（这页没有频道栏的用户栏）：头像 + 齿轮，退出登录在设置左侧导航底部 */}
            {user ? (
              <Button
                variant="ghost"
                aria-label="用户设置"
                data-testid="home-settings"
                onPress={() => setSettingsOpen(true)}
                className="h-10 min-h-0 gap-2 rounded-lg bg-transparent px-2 text-sm font-normal text-[#b5bac1] hover:bg-white/5 hover:text-white data-[hovered=true]:bg-white/5"
              >
                <MemberAvatar member={user} size={28} />
                <GearIcon />
              </Button>
            ) : null}
          </div>
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-[#949ba4]">我的 Team — {teams.length}</h2>
          {!loading && teams.length === 0 ? (
            <div className="mb-10 flex flex-col items-center rounded-xl border border-dashed border-white/10 bg-[#2b2d31] px-6 py-10 text-center">
              <div className="mb-3 text-4xl" aria-hidden="true">
                👋
              </div>
              <h3 className="text-lg font-semibold text-white">还没有加入任何 Team</h3>
              <p className="mt-1 max-w-md text-sm text-[#949ba4]">在下面创建一个属于你的 Team，或者粘贴别人发给你的邀请链接加入。</p>
            </div>
          ) : (
            <div className="mb-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {teams.map((t) => (
                <Link
                  key={t.id}
                  to={`/teams/${t.id}`}
                  className="group flex cursor-pointer items-start gap-3 rounded-xl bg-[#2b2d31] p-4 ring-1 ring-transparent transition hover:-translate-y-0.5 hover:bg-[#35373c] hover:shadow-lg hover:ring-brand/50"
                >
                  <TeamIcon team={t} size={48} className="rounded-2xl" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold text-white group-hover:text-brand-light">{t.name}</span>
                    <span className="mt-0.5 line-clamp-2 text-xs text-[#949ba4]">{t.description || "暂无简介"}</span>
                    <span className="mt-2 inline-block rounded bg-white/5 px-1.5 py-0.5 text-[11px] text-[#b5bac1]">{roleLabel(t.my_role)}</span>
                  </span>
                </Link>
              ))}
            </div>
          )}
          <div className="grid gap-4 md:grid-cols-2">
            <section className="rounded-xl bg-[#2b2d31] p-6">
              <h2 className="mb-3 text-lg font-semibold text-white">创建 Team</h2>
              <CreateTeamForm token={token} onDone={onCreated} />
            </section>
            <section className="rounded-xl bg-[#2b2d31] p-6">
              <h2 className="mb-3 text-lg font-semibold text-white">加入 Team</h2>
              <JoinByInviteForm />
            </section>
          </div>
        </div>
      </main>
      {dialog ? <TeamDialog token={token} onClose={() => setDialog(false)} onDone={onCreated} /> : null}
      {settingsOpen ? <SettingsDialog onClose={() => setSettingsOpen(false)} /> : null}
    </div>
  );
}
