import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { Button, Card, Spinner } from "@heroui/react";
import { api, ApiError } from "../api";
import type { InviteInvalidReason, InvitePreview } from "../api/types";
import { useAuth } from "../auth/AuthContext";
import { initials } from "../components/MemberAvatar";
import { LogoWordmark } from "../components/Logo";
import { INVITE_REASON_HINT, reasonFromErrorCode, withRedirect } from "../lib/invite";

/** 邀请落地页 /invite/:code：未登录也能预览 */
export default function InvitePage() {
  const { code = "" } = useParams();
  const { user, token, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [problem, setProblem] = useState<InviteInvalidReason | "not_found" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [joining, setJoining] = useState(false);
  const here = `/invite/${encodeURIComponent(code)}`;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .previewInvite(code)
      .then((p) => {
        if (cancelled) return;
        setPreview(p);
        setProblem(p.valid ? null : (p.reason ?? "expired"));
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        const reason = e instanceof ApiError ? reasonFromErrorCode(e.code) : null;
        if (reason) setProblem(reason);
        else setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [code]);

  async function join() {
    if (!token) return;
    setJoining(true);
    setError(null);
    try {
      // 成功或 already_member 都直接进入该 team；team 列表由 useTeams 按 id 去重合并 team.joined
      const res = await api.acceptInvite(token, code);
      navigate(`/teams/${res.team.id}`, { replace: true });
    } catch (e) {
      const reason = e instanceof ApiError ? reasonFromErrorCode(e.code) : null;
      if (reason) setProblem(reason);
      else setError(e instanceof Error ? e.message : String(e));
    } finally {
      setJoining(false);
    }
  }

  const team = preview?.team;
  return (
    <div className="relative flex min-h-full items-center justify-center bg-[#313338] bg-[radial-gradient(circle_at_20%_20%,#6d5cf633,transparent_40%),radial-gradient(circle_at_80%_80%,#23a55a22,transparent_40%)] p-6">
      <div className="absolute left-6 top-5">
        <LogoWordmark size={32} />
      </div>
      <Card className="w-full max-w-md bg-[#2b2d31] p-2 text-center">
        {loading ? (
          <Card.Content className="flex justify-center py-10">
            <Spinner />
          </Card.Content>
        ) : (
          <>
            <Card.Header className="items-center">
              {team ? (
                <span className="mb-3 flex h-20 w-20 items-center justify-center overflow-hidden rounded-3xl bg-brand text-2xl font-bold text-white">
                  {team.icon_url ? <img src={team.icon_url} alt="" className="h-full w-full object-cover" /> : initials(team.name)}
                </span>
              ) : (
                <span className="mb-3 flex h-20 w-20 items-center justify-center rounded-3xl bg-[#1e1f22] text-3xl">🔗</span>
              )}
              <Card.Description>{team ? "你被邀请加入" : "TeAms 邀请"}</Card.Description>
              <Card.Title className="text-2xl">{team?.name ?? "邀请不可用"}</Card.Title>
              {team ? <p className="text-sm text-[#949ba4]">{team.member_count} 位成员</p> : null}
            </Card.Header>
            <Card.Content className="flex flex-col gap-3">
              {problem ? (
                <p className="rounded-md bg-[#f23f43]/15 p-3 text-sm text-[#f8a5a7]">{INVITE_REASON_HINT[problem]}</p>
              ) : null}
              {error ? <p className="text-sm text-[#f23f43]">{error}</p> : null}
              {!problem && team ? (
                authLoading ? (
                  <div className="flex justify-center">
                    <Spinner size="sm" />
                  </div>
                ) : user ? (
                  <>
                    <Button variant="primary" fullWidth isPending={joining} onPress={() => void join()}>
                      加入 {team.name}
                    </Button>
                    <p className="text-xs text-[#949ba4]">将以 {user.display_name}（@{user.username}）的身份加入</p>
                  </>
                ) : (
                  <>
                    <Button variant="primary" fullWidth onPress={() => navigate(withRedirect("/login", here))}>
                      登录后加入
                    </Button>
                    <Button variant="secondary" fullWidth onPress={() => navigate(withRedirect("/register", here))}>
                      注册
                    </Button>
                  </>
                )
              ) : null}
              <Link to={user ? "/teams" : "/login"} className="text-sm text-brand-light hover:underline">
                {user ? "回到我的 Team" : "去登录"}
              </Link>
            </Card.Content>
          </>
        )}
      </Card>
    </div>
  );
}
