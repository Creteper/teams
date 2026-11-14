import { useEffect, useRef, useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router";
import { Spinner } from "@heroui/react";
import { api, realtime } from "../api";
import type { Channel, Member, Message, Team } from "../api/types";
import { useAuth, useToken } from "../auth/AuthContext";
import { ChannelSidebar } from "../components/ChannelSidebar";
import { Composer } from "../components/Composer";
import { MemberList } from "../components/MemberList";
import { MessageList } from "../components/MessageList";
import { TeamDialog } from "../components/TeamForms";
import { TeamRail } from "../components/TeamRail";
import { useTeams } from "../hooks";
import { mergeMessages } from "../lib/messages";

/** Team 主界面（Discord 式四栏）：team 图标栏 | 频道侧栏 | 消息区 | 成员列表 */
export default function TeamPage() {
  const { teamId = "", channelId } = useParams();
  const token = useToken();
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const { teams, reload: reloadTeams } = useTeams(token);

  const [team, setTeam] = useState<Team | null>(null);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const maxSeqRef = useRef(0);

  useEffect(() => {
    maxSeqRef.current = messages.reduce((mx, m) => Math.max(mx, m.seq), 0);
  }, [messages]);

  // team / 频道 / 成员
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([api.getTeam(token, teamId), api.listChannels(token, teamId), api.listMembers(token, teamId)])
      .then(([t, cs, ms]) => {
        if (cancelled) return;
        setTeam(t);
        setChannels(cs);
        setMembers(ms);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token, teamId]);

  // 当前频道首屏消息
  useEffect(() => {
    if (!channelId) return;
    let cancelled = false;
    setMessages([]);
    api
      .listMessages(token, channelId, { limit: 50 })
      .then((page) => {
        if (!cancelled) setMessages(page.items);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [token, channelId]);

  // 断线重连后用 after=<seq> 补拉（docs/api.md §8.3）
  useEffect(() => {
    if (!channelId) return;
    return realtime.onReady(() => {
      if (!maxSeqRef.current) return;
      api
        .listMessages(token, channelId, { after: maxSeqRef.current, limit: 100 })
        .then((page) => setMessages((prev) => mergeMessages(prev, page.items)))
        .catch(() => undefined);
    });
  }, [token, channelId]);

  // 实时推送
  useEffect(() => {
    return realtime.subscribe((frame) => {
      if (frame.team_id && frame.team_id !== teamId) return;
      switch (frame.type) {
        case "message.created":
        case "message.updated":
          if (frame.data.channel_id === channelId) setMessages((prev) => mergeMessages(prev, [frame.data]));
          break;
        case "message.deleted":
          setMessages((prev) =>
            prev.map((m) => (m.id === frame.data.id ? { ...m, deleted: true, content: "", attachments: [] } : m)),
          );
          break;
        case "member.joined":
        case "member.updated":
          setMembers((prev) => [...prev.filter((m) => m.id !== frame.data.id), frame.data]);
          break;
        case "member.left":
          setMembers((prev) => prev.filter((m) => m.id !== frame.data.member_id));
          break;
        case "channel.created":
        case "channel.updated":
          setChannels((prev) =>
            prev.some((c) => c.id === frame.data.id)
              ? prev.map((c) => (c.id === frame.data.id ? frame.data : c))
              : [...prev, frame.data],
          );
          break;
        case "channel.deleted":
          setChannels((prev) => prev.filter((c) => c.id !== frame.data.id));
          if (frame.data.id === channelId) navigate(`/teams/${teamId}`, { replace: true });
          break;
        case "team.updated":
          setTeam(frame.data);
          void reloadTeams();
          break;
        case "team.deleted":
        case "team.removed":
          if (frame.data.team_id === teamId) {
            void reloadTeams();
            navigate("/teams", { replace: true });
          }
          break;
      }
    });
  }, [teamId, channelId, navigate, reloadTeams]);

  if (!user) return null;
  if (!channelId && channels.length > 0 && channels[0].team_id === teamId) {
    const general = channels.find((c) => c.name === "general") ?? channels[0];
    return <Navigate to={`/teams/${teamId}/channels/${general.id}`} replace />;
  }
  const channel = channels.find((c) => c.id === channelId);
  const myMemberId = team?.my_member_id ?? "";
  const canManage = team?.my_role === "owner" || team?.my_role === "admin";

  return (
    <div className="flex h-full overflow-hidden bg-[#313338] text-[#dbdee1]">
      <TeamRail teams={teams} currentTeamId={teamId} onAdd={() => setDialogOpen(true)} />
      <ChannelSidebar
        team={team}
        channels={channels}
        currentChannelId={channelId}
        me={user}
        onCreateChannel={async (name) => {
          const c = await api.createChannel(token, teamId, { name });
          setChannels((prev) => (prev.some((x) => x.id === c.id) ? prev : [...prev, c]));
          navigate(`/teams/${teamId}/channels/${c.id}`);
        }}
        onLogout={() => void logout()}
      />

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-black/30 px-4 shadow-sm">
          <span className="text-2xl leading-none text-[#80848e]">#</span>
          <h1 className="font-semibold text-[#f2f3f5]">{channel?.name ?? "…"}</h1>
          {channel?.topic ? (
            <>
              <span className="mx-2 h-6 w-px bg-[#3f4147]" />
              <span className="truncate text-sm text-[#949ba4]">{channel.topic}</span>
            </>
          ) : null}
        </header>
        {error ? <div className="bg-[#f23f43]/20 px-4 py-2 text-sm text-[#f23f43]">{error}</div> : null}
        {loading ? (
          <div className="flex flex-1 items-center justify-center">
            <Spinner />
          </div>
        ) : channel ? (
          <>
            <MessageList messages={messages} members={members} myMemberId={myMemberId} />
            <Composer
              channelName={channel.name}
              members={members.filter((m) => m.id !== myMemberId)}
              onUpload={(file) => api.uploadAttachment(token, teamId, file)}
              onSend={async ({ content, attachments }) => {
                // 发消息只走 REST（§8.2）；client_msg_id 作幂等键
                const msg = await api.sendMessage(token, channel.id, {
                  content,
                  attachment_ids: attachments.map((a) => a.id),
                  client_msg_id: `c-${crypto.randomUUID()}`,
                });
                setMessages((prev) => mergeMessages(prev, [msg]));
              }}
            />
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-[#949ba4]">选择一个频道开始聊天</div>
        )}
      </main>

      <MemberList
        members={members}
        canAdd={canManage}
        onAdd={async (username) => {
          const m = await api.addMember(token, teamId, { username, role: "member" });
          setMembers((prev) => [...prev.filter((x) => x.id !== m.id), m]);
        }}
      />

      {dialogOpen ? (
        <TeamDialog
          token={token}
          onClose={() => setDialogOpen(false)}
          onDone={async (t) => {
            setDialogOpen(false);
            await reloadTeams();
            navigate(`/teams/${t.id}`);
          }}
        />
      ) : null}
    </div>
  );
}
