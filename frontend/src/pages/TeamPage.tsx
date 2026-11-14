import { useCallback, useEffect, useReducer, useRef, useState } from "react";
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
import { InviteDialog } from "../components/InviteDialog";
import { TeamRail } from "../components/TeamRail";
import { useTeams } from "../hooks";
import { mergeMessages } from "../lib/messages";
import { applyAttachmentUrls, chunk, idsNeedingRefresh } from "../lib/attachments";
import { botRunsReducer } from "../lib/botRuns";
import { newClientMsgId, type OutboxItem } from "../lib/outbox";
import { BotRunBar } from "../components/BotRunBar";
import { TeamSettingsDialog } from "../components/TeamSettingsDialog";
import { ProfileDialog } from "../components/ProfileDialog";
import { ConfirmDialog } from "../components/ui";
import { channelErrorText, defaultChannel } from "../lib/channels";
import { RenameChannelDialog } from "../components/RenameChannelDialog";
import { MemberProfileDialog } from "../components/MemberProfileDialog";
import { optimisticRoleChange, syncMyRole, upsertMember, type RoleAction } from "../lib/memberRoles";
import type { Attachment, MessageSender } from "../api/types";

/** Team 主界面（Discord 式四栏）：team 图标栏 | 频道侧栏 | 消息区 | 成员列表 */
export default function TeamPage() {
  const { teamId = "", channelId } = useParams();
  const token = useToken();
  const { user, logout, syncUser } = useAuth();
  const navigate = useNavigate();
  const { teams, reload: reloadTeams } = useTeams(token);

  const [team, setTeam] = useState<Team | null>(null);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [olderCursor, setOlderCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [messagesLoading, setMessagesLoading] = useState(true);
  const [outbox, setOutbox] = useState<OutboxItem[]>([]);
  const [botRuns, dispatchRuns] = useReducer(botRunsReducer, {});
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [confirm, setConfirm] = useState<null | "leave" | "logout">(null);
  const [confirmPending, setConfirmPending] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  // 设为/取消管理员：取消前二次确认；乐观更新，失败回滚并提示
  const [demoteTarget, setDemoteTarget] = useState<Member | null>(null);
  const [rolePendingId, setRolePendingId] = useState<string | null>(null);
  const [roleNotice, setRoleNotice] = useState<string | null>(null);
  // 频道菜单：改名弹窗、删除确认；频道相关提示（如“当前频道已被删除”）
  const [renameTarget, setRenameTarget] = useState<Channel | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Channel | null>(null);
  const [deletePending, setDeletePending] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [channelNotice, setChannelNotice] = useState<string | null>(null);
  const [profileMemberId, setProfileMemberId] = useState<string | null>(null);
  const channelsRef = useRef<Channel[]>([]);
  useEffect(() => {
    channelsRef.current = channels;
  }, [channels]);
  const maxSeqRef = useRef(0);
  const messagesRef = useRef<Message[]>([]);
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
    setMessagesLoading(true);
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
      })
      .finally(() => {
        if (!cancelled) setMessagesLoading(false);
      });
    // 进入频道：拉进行中的 bot 处理
    api
      .listActiveBotRuns(token, channelId)
      .then((items) => !cancelled && dispatchRuns({ type: "hydrate", items, now: Date.now() }))
      .catch(() => undefined);
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
      const ids = idsNeedingRefresh(messagesRef.current, Date.now());
      for (const batch of chunk(ids, 100)) {
        try {
          const { items } = await api.refreshAttachmentUrls(token, batch);
          setMessages((prev) => applyAttachmentUrls(prev, items));
        } catch {
          /* 下次再试 */
        }
      }
    }, 60_000);
    return () => clearInterval(timer);
  }, [token]);

  // 图片/视频加载失败：单个刷新（自动只重试一次；用户点“重试”时 force）
  const onMediaError = useCallback(
    async (attachmentId: string, force = false) => {
      if (!force && retriedRef.current.has(attachmentId)) return;
      retriedRef.current.add(attachmentId);
      try {
        const u = await api.getAttachment(token, attachmentId);
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
      api
        .listActiveBotRuns(token, channelId)
        .then((items) => dispatchRuns({ type: "hydrate", items, now: Date.now() }))
        .catch(() => undefined);
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
          dispatchRuns({ type: "message", message: frame.data });
          if (frame.data.channel_id === channelId) setMessages((prev) => mergeMessages(prev, [frame.data]));
          break;
        case "message.updated":
          if (frame.data.channel_id === channelId) setMessages((prev) => mergeMessages(prev, [frame.data]));
          break;
        case "bot.run.started":
        case "bot.run.delivered":
        case "bot.run.retrying":
        case "bot.run.failed":
        case "bot.run.completed":
          dispatchRuns({
            type: "event",
            event: frame.type.slice("bot.run.".length) as "started",
            data: frame.data,
            now: Date.now(),
          });
          break;
        case "message.deleted":
          setMessages((prev) =>
            prev.map((m) => (m.id === frame.data.id ? { ...m, deleted: true, content: "", attachments: [] } : m)),
          );
          break;
        case "member.joined":
        case "member.updated":
          // 原位替换（角色变化不打乱顺序）；是我自己时同步 my_role，入口/权限立即跟着变
          setMembers((prev) => upsertMember(prev, frame.data));
          setTeam((prev) => syncMyRole(prev, frame.data));
          // 自己在别的窗口改了昵称 / 头像：同步左下角个人区
          if (frame.type === "member.updated" && frame.data.type === "user" && frame.data.user_id === user?.id)
            syncUser({ display_name: frame.data.display_name, avatar_url: frame.data.avatar_url });
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
        case "channel.deleted": {
          const removed = channelsRef.current.find((c) => c.id === frame.data.id);
          const rest = channelsRef.current.filter((c) => c.id !== frame.data.id);
          setChannels((prev) => prev.filter((c) => c.id !== frame.data.id));
          setDeleteTarget((t) => (t?.id === frame.data.id ? null : t));
          setRenameTarget((t) => (t?.id === frame.data.id ? null : t));
          // 当前打开的频道被删：跳到默认频道并提示
          if (frame.data.id === channelId) {
            const fallback = defaultChannel(rest);
            setChannelNotice(`频道 #${removed?.name ?? ""} 已被删除，已切换到 #${fallback?.name ?? "默认频道"}`);
            navigate(fallback ? `/teams/${teamId}/channels/${fallback.id}` : `/teams/${teamId}`, { replace: true });
          }
          break;
        }
        case "team.updated":
          // 只合并公共字段，my_role / my_member_id 保留本地（推送给全员的对象不一定是“我”的视角）
          if (frame.data.id === teamId)
            setTeam((prev) =>
              prev
                ? { ...prev, name: frame.data.name, description: frame.data.description, icon_url: frame.data.icon_url }
                : frame.data,
            );
          break;
        case "team.deleted":
        case "team.removed":
          // 被移出 / team 被删：正在该 team 就跳回 team 列表（图标栏由 useTeams 更新）
          if (frame.data.team_id === teamId) navigate("/teams", { replace: true });
          break;
      }
    });
  }, [teamId, channelId, navigate, user?.id, syncUser]);

  // 90 秒兜底：每 5 秒检查一次
  useEffect(() => {
    const t = setInterval(() => dispatchRuns({ type: "tick", now: Date.now() }), 5000);
    return () => clearInterval(t);
  }, []);

  // 切频道时清掉本地待发送
  useEffect(() => {
    setOutbox((prev) => prev.filter((o) => o.status === "failed" || o.channel_id === channelId));
  }, [channelId]);

  /** 发送（只走 REST）：先乐观显示，失败标记可重发/删除；client_msg_id 重发时不变，后端幂等 */
  const deliver = useCallback(
    async (item: OutboxItem) => {
      setOutbox((prev) => prev.map((o) => (o.local_id === item.local_id ? { ...o, status: "sending", error: undefined } : o)));
      try {
        const msg = await api.sendMessage(token, item.channel_id, {
          content: item.content,
          attachment_ids: item.attachments.map((a) => a.id),
          client_msg_id: item.client_msg_id,
        });
        setOutbox((prev) => prev.filter((o) => o.local_id !== item.local_id));
        setMessages((prev) => (msg.channel_id === channelId ? mergeMessages(prev, [msg]) : prev));
        const bots = msg.mentions.filter((m) => m.type === "bot").map((m) => m.member_id);
        if (bots.length)
          dispatchRuns({ type: "optimistic", trigger_message_id: msg.id, channel_id: msg.channel_id, bot_member_ids: bots, now: Date.now() });
      } catch (e) {
        setOutbox((prev) =>
          prev.map((o) => (o.local_id === item.local_id ? { ...o, status: "failed", error: e instanceof Error ? e.message : String(e) } : o)),
        );
      }
    },
    [token, channelId],
  );

  async function runConfirm() {
    setConfirmPending(true);
    setConfirmError(null);
    try {
      if (confirm === "leave") {
        await api.leaveTeam(token, teamId);
        await reloadTeams();
        navigate("/teams", { replace: true });
      } else if (confirm === "logout") {
        await logout();
      }
      setConfirm(null);
    } catch (e) {
      setConfirmError(e instanceof Error ? e.message : String(e));
    } finally {
      setConfirmPending(false);
    }
  }

  async function changeRole(target: Member, action: RoleAction) {
    setRoleNotice(null);
    setRolePendingId(target.id);
    const failure = await optimisticRoleChange(target, action, setMembers, (role) =>
      api.updateMemberRole(token, teamId, target.id, { role }),
    );
    setRolePendingId(null);
    if (failure) setRoleNotice(failure);
  }

  if (!user) return null;
  if (!channelId && channels.length > 0 && channels[0].team_id === teamId) {
    const general = defaultChannel(channels) ?? channels[0];
    return <Navigate to={`/teams/${teamId}/channels/${general.id}`} replace />;
  }
  const channel = channels.find((c) => c.id === channelId);
  const myMemberId = team?.my_member_id ?? "";
  const canManage = team?.my_role === "owner" || team?.my_role === "admin";
  const me = members.find((m) => m.id === myMemberId);
  const mySender: MessageSender = {
    member_id: myMemberId,
    type: "user",
    display_name: me?.display_name ?? user.display_name,
    avatar_url: me?.avatar_url ?? user.avatar_url,
    avatar_shape: null,
    avatar_color: null,
  };
  const channelRuns = Object.values(botRuns)
    .filter((r) => r.channel_id === channelId)
    .sort((a, b) => a.startedAt - b.startedAt);

  return (
    <div className="flex h-full overflow-hidden bg-[#313338] text-[#dbdee1]">
      <TeamRail teams={teams} currentTeamId={teamId} onAdd={() => setDialogOpen(true)} />
      <ChannelSidebar
        team={team}
        channels={channels}
        currentChannelId={channelId}
        me={user}
        canManage={canManage}
        onCreateChannel={async (name) => {
          const c = await api.createChannel(token, teamId, { name });
          setChannels((prev) => (prev.some((x) => x.id === c.id) ? prev : [...prev, c]));
          navigate(`/teams/${teamId}/channels/${c.id}`);
        }}
        onInvite={() => setInviteOpen(true)}
        onSettings={() => setSettingsOpen(true)}
        onLeave={() => {
          setConfirmError(null);
          setConfirm("leave");
        }}
        onLogout={() => {
          setConfirmError(null);
          setConfirm("logout");
        }}
        onEditProfile={() => setProfileOpen(true)}
        myMemberId={myMemberId}
        onChannelAction={(c, action) => {
          if (action === "rename") setRenameTarget(c);
          else if (action === "delete") {
            setDeleteError(null);
            setDeleteTarget(c);
          }
        }}
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
        {channelNotice ? (
          <div role="status" className="flex items-center gap-2 bg-[#f0b232]/15 px-4 py-2 text-sm text-[#f0b232]">
            <span className="flex-1">{channelNotice}</span>
            <button type="button" aria-label="关闭提示" onClick={() => setChannelNotice(null)} className="hover:text-white">
              ✕
            </button>
          </div>
        ) : null}
        {loading ? (
          <div className="flex flex-1 items-center justify-center">
            <Spinner />
          </div>
        ) : channel ? (
          <>
            <MessageList
              messages={messages}
              outbox={outbox.filter((o) => o.channel_id === channel.id)}
              members={members}
              myMemberId={myMemberId}
              channel={channel}
              initialLoading={messagesLoading}
              hasMore={hasMore}
              loadingOlder={loadingOlder}
              onLoadOlder={loadOlder}
              onMediaError={(id) => void onMediaError(id)}
              onMediaRetry={(id) => void onMediaError(id, true)}
              onRetrySend={(localId) => {
                const item = outbox.find((o) => o.local_id === localId);
                if (item) void deliver(item);
              }}
              onDiscard={(localId) => setOutbox((prev) => prev.filter((o) => o.local_id !== localId))}
            />
            {/* bot 状态区：消息列表和输入框之间单独一行，处于正常文档流；出现时列表通过 ResizeObserver 贴底 */}
            <BotRunBar
              runs={channelRuns}
              members={members}
              showTechnicalReason={canManage}
              onDismiss={(key) => dispatchRuns({ type: "dismiss", key })}
            />
            <Composer
              key={channel.id}
              channelName={channel.name}
              members={members.filter((m) => m.id !== myMemberId)}
              onUpload={(file, opts) => api.uploadAttachment(token, teamId, file, opts)}
              onSend={({ content, attachments, mentionIds }) => {
                const item: OutboxItem = {
                  local_id: `local-${crypto.randomUUID()}`,
                  channel_id: channel.id,
                  content,
                  attachments: attachments as Attachment[],
                  client_msg_id: newClientMsgId(),
                  status: "sending",
                  created_at: new Date().toISOString(),
                  sender: mySender,
                  bot_member_ids: members.filter((m) => m.type === "bot" && mentionIds.includes(m.id)).map((m) => m.id),
                };
                setOutbox((prev) => [...prev, item]);
                void deliver(item);
              }}
            />
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-[#949ba4]">选择一个频道开始聊天</div>
        )}
      </main>

      <MemberList
        members={members}
        onInvite={canManage ? () => setInviteOpen(true) : undefined}
        roles={{
          myRole: team?.my_role,
          myMemberId,
          pendingId: rolePendingId,
          onAction: (m, action) => (action === "demote" ? setDemoteTarget(m) : void changeRole(m, action)),
        }}
        notice={roleNotice}
        onDismissNotice={() => setRoleNotice(null)}
        onProfile={(m) => setProfileMemberId(m.id)}
      />

      {profileMemberId && members.some((m) => m.id === profileMemberId) ? (
        <MemberProfileDialog
          token={token}
          member={members.find((m) => m.id === profileMemberId)!}
          isMe={profileMemberId === myMemberId}
          onClose={() => setProfileMemberId(null)}
        />
      ) : null}

      {renameTarget ? (
        <RenameChannelDialog
          channel={renameTarget}
          channels={channels}
          onClose={() => setRenameTarget(null)}
          onSubmit={async (name) => {
            const c = await api.updateChannel(token, renameTarget.id, { name });
            setChannels((prev) => prev.map((x) => (x.id === c.id ? c : x)));
          }}
        />
      ) : null}

      {deleteTarget ? (
        <ConfirmDialog
          title="删除频道"
          message={
            <>
              确定删除 <span className="font-medium text-[#f2f3f5]">#{deleteTarget.name}</span> 吗？频道里的消息将无法再查看，此操作不能撤销。
            </>
          }
          confirmText="删除频道"
          pending={deletePending}
          error={deleteError}
          onConfirm={async () => {
            const target = deleteTarget;
            setDeletePending(true);
            setDeleteError(null);
            try {
              await api.deleteChannel(token, target.id);
              const rest = channelsRef.current.filter((c) => c.id !== target.id);
              setChannels((prev) => prev.filter((c) => c.id !== target.id));
              setDeleteTarget(null);
              if (target.id === channelId) {
                const fallback = defaultChannel(rest);
                navigate(fallback ? `/teams/${teamId}/channels/${fallback.id}` : `/teams/${teamId}`, { replace: true });
              }
            } catch (e) {
              setDeleteError(channelErrorText(e, "delete"));
            } finally {
              setDeletePending(false);
            }
          }}
          onCancel={() => setDeleteTarget(null)}
        />
      ) : null}

      {demoteTarget ? (
        <ConfirmDialog
          title="取消管理员"
          message={
            <>
              确定取消 <span className="font-medium text-[#f2f3f5]">{demoteTarget.display_name}</span>（@{demoteTarget.username}）的管理员身份吗？
              取消后 TA 将不能再管理频道、邀请和 Team 设置。
            </>
          }
          confirmText="取消管理员"
          onConfirm={() => {
            const t = demoteTarget;
            setDemoteTarget(null);
            void changeRole(t, "demote");
          }}
          onCancel={() => setDemoteTarget(null)}
        />
      ) : null}

      {inviteOpen && team && canManage ? (
        <InviteDialog
          token={token}
          team={team}
          onClose={() => setInviteOpen(false)}
          onMemberAdded={(m) => setMembers((prev) => upsertMember(prev, m))}
        />
      ) : null}

      {settingsOpen && team && canManage ? (
        <TeamSettingsDialog
          token={token}
          team={team}
          onClose={() => setSettingsOpen(false)}
          onSaved={(t) => {
            setTeam((prev) => (prev ? { ...prev, name: t.name, description: t.description, icon_url: t.icon_url } : t));
            setSettingsOpen(false);
            void reloadTeams();
          }}
        />
      ) : null}

      {profileOpen ? <ProfileDialog onClose={() => setProfileOpen(false)} /> : null}

      {confirm === "leave" && team ? (
        <ConfirmDialog
          title={`退出「${team.name}」`}
          message={<>确定要退出这个 team 吗？退出后需要重新被邀请才能回来。</>}
          confirmText="退出 Team"
          pending={confirmPending}
          error={confirmError}
          onConfirm={() => void runConfirm()}
          onCancel={() => setConfirm(null)}
        />
      ) : null}
      {confirm === "logout" ? (
        <ConfirmDialog
          title="退出登录"
          message={<>确定要退出登录吗？</>}
          confirmText="退出登录"
          pending={confirmPending}
          error={confirmError}
          onConfirm={() => void runConfirm()}
          onCancel={() => setConfirm(null)}
        />
      ) : null}

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
