import { useCallback, useEffect, useRef, useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router";
import { Spinner } from "@heroui/react";
import { api, fetchAllMembers, realtime } from "../api";
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
import { applyAttachmentUrls, chunk, idsNeedingRefresh } from "../lib/attachments";

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
  const [olderCursor, setOlderCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const maxSeqRef = useRef(0);
  const messagesRef = useRef<Message[]>([]);
  /** 附件 id -> 已知到期时间（来自刷新接口的 expires_at） */
  const expiriesRef = useRef(new Map<string, number>());
  /** 加载失败已重试过的附件 id（只重试一次） */
  const retriedRef = useRef(new Set<string>());

  useEffect(() => {
    messagesRef.current = messages;
    maxSeqRef.current = messages.reduce((mx, m) => Math.max(mx, m.seq), 0);
  }, [messages]);

  // team / 频道 / 成员
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([api.getTeam(token, teamId), api.listChannels(token, teamId), fetchAllMembers(api, token, teamId)])
      .then(([t, cs, ms]) => {
        if (cancelled) return;
        setTeam(t);
        setChannels(cs.items);
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
    setHasMore(false);
    setOlderCursor(null);
    api
      .listMessages(token, channelId, { limit: 50 })
      .then((page) => {
        if (cancelled) return;
        setMessages(page.items);
        setHasMore(page.has_more);
        setOlderCursor(page.next_cursor);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [token, channelId]);

  // 向上滚动加载更早消息：before = 上一页 next_cursor（本页最小 seq）
  const loadOlder = useCallback(async () => {
    if (!channelId || !hasMore || !olderCursor || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const page = await api.listMessages(token, channelId, { before: Number(olderCursor), limit: 50 });
      setMessages((prev) => mergeMessages(prev, page.items));
      setHasMore(page.has_more);
      setOlderCursor(page.next_cursor);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingOlder(false);
    }
  }, [token, channelId, hasMore, olderCursor, loadingOlder]);

  // 签名 URL 快到期时批量刷新（每分钟检查，提前 5 分钟，单批 ≤100）
  useEffect(() => {
    const timer = setInterval(async () => {
      const ids = idsNeedingRefresh(messagesRef.current, expiriesRef.current, Date.now());
      for (const batch of chunk(ids, 100)) {
        try {
          const urls = await api.refreshAttachmentUrls(token, batch);
          urls.forEach((u) => expiriesRef.current.set(u.id, Date.parse(u.expires_at)));
          setMessages((prev) => applyAttachmentUrls(prev, urls));
        } catch {
          /* 下次再试 */
        }
      }
    }, 60_000);
    return () => clearInterval(timer);
  }, [token]);

  // 图片/视频加载失败：单个刷新并重试一次
  const onMediaError = useCallback(
    async (attachmentId: string) => {
      if (retriedRef.current.has(attachmentId)) return;
      retriedRef.current.add(attachmentId);
      try {
        const u = await api.getAttachmentUrl(token, attachmentId);
        expiriesRef.current.set(u.id, Date.parse(u.expires_at));
        setMessages((prev) => applyAttachmentUrls(prev, [u]));
      } catch {
        /* 放弃 */
      }
    },
    [token],
  );

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
          if (frame.data.id === teamId) setTeam(frame.data);
          break;
        case "team.deleted":
        case "team.removed":
          // 被移出 / team 被删：正在该 team 就跳回 team 列表（图标栏由 useTeams 更新）
          if (frame.data.team_id === teamId) navigate("/teams", { replace: true });
          break;
      }
    });
  }, [teamId, channelId, navigate]);

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
            <MessageList
              messages={messages}
              members={members}
              myMemberId={myMemberId}
              hasMore={hasMore}
              loadingOlder={loadingOlder}
              onLoadOlder={loadOlder}
              onMediaError={onMediaError}
            />
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
