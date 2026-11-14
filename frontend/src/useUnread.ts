import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, realtime } from "./api";
import type { Channel, ChannelUserState, Team } from "./api/types";
import {
  applyState,
  markReadLocal,
  mergeUnreadSummary,
  myMemberIds,
  onMessageCreated,
  removeChannel,
  removeTeam,
  seedTeam,
  teamSummary,
  type UnreadMap,
} from "./lib/unread";

/**
 * 未读 / 置顶状态（docs/api.md §5.7）：
 * - 进入 team：用频道列表的字段初始化（seed）；其他 team 用 GET /me/unread；
 * - message.created：不是正在看的频道才累加（普通消息、未删除、不是自己发的）；
 * - channel.read / channel.pinned（仅本人的所有连接）：直接覆盖 → 多标签页 / 多设备同步；
 * - 打开频道、正在看的频道来新消息：POST /channels/{id}/read {seq}（只前进）；页面在后台时等回到前台再标；
 * - 断线重连：重新拉 /me/unread（当前 team 的频道列表由 TeamPage 重拉后 seed）。
 */
export function useUnread({ token, teams, teamId, viewingChannelId }: { token: string; teams: Team[]; teamId: string; viewingChannelId?: string }) {
  const [map, setMap] = useState<UnreadMap>({});
  const mapRef = useRef(map);
  mapRef.current = map;
  const viewingRef = useRef(viewingChannelId);
  viewingRef.current = viewingChannelId;
  const myIdsRef = useRef<Record<string, string>>({});
  myIdsRef.current = myMemberIds(teams);
  /** 每个频道已发出的最大已读 seq，避免重复请求 */
  const postedRef = useRef<Record<string, number>>({});
  /** 页面在后台时攒着，回到前台再标已读 */
  const pendingReadRef = useRef<{ channelId: string; seq?: number } | null>(null);

  const loadSummary = useCallback(async () => {
    try {
      const items = await api.listMyUnread(token);
      // 当前 team 的频道以频道列表为准（它更完整），汇总只补其他 team
      setMap((m) => mergeUnreadSummary(m, items, teamId));
    } catch {
      /* 汇总失败不影响主界面 */
    }
  }, [token, teamId]);

  useEffect(() => {
    void loadSummary();
  }, [loadSummary]);
  useEffect(() => realtime.onReady(() => void loadSummary()), [loadSummary]);

  const seed = useCallback((tid: string, channels: Channel[]) => setMap((m) => seedTeam(m, tid, channels)), []);
  const apply = useCallback((st: ChannelUserState) => setMap((m) => applyState(m, st)), []);

  const markRead = useCallback(
    async (channelId: string, seq?: number) => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        pendingReadRef.current = { channelId, seq: Math.max(seq ?? 0, pendingReadRef.current?.channelId === channelId ? (pendingReadRef.current.seq ?? 0) : 0) || undefined };
        return;
      }
      const st = mapRef.current[channelId];
      const posted = postedRef.current[channelId] ?? -1;
      // 只前进：已经标到（或已知已读到）这个位置、而且没有未读，就不再发
      if (seq !== undefined && st && seq <= Math.max(posted, st.last_read_seq) && !st.unread_count && !st.has_unread_mention) return;
      if (seq !== undefined) postedRef.current[channelId] = Math.max(posted, seq);
      setMap((m) => markReadLocal(m, channelId, seq));
      try {
        const res = await api.markChannelRead(token, channelId, seq);
        setMap((m) => applyState(m, res));
      } catch {
        delete postedRef.current[channelId];
      }
    },
    [token],
  );

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== "visible" || !pendingReadRef.current) return;
      const p = pendingReadRef.current;
      pendingReadRef.current = null;
      if (p.channelId === viewingRef.current) void markRead(p.channelId, p.seq);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [markRead]);

  const setPinned = useCallback(
    async (channelId: string, pinned: boolean) => {
      const prev = mapRef.current[channelId];
      if (prev) setMap((m) => applyState(m, { ...prev, pinned, pinned_at: pinned ? prev.pinned_at ?? new Date().toISOString() : null }));
      try {
        const res = pinned ? await api.pinChannel(token, channelId) : await api.unpinChannel(token, channelId);
        setMap((m) => applyState(m, res));
      } catch (e) {
        if (prev) setMap((m) => applyState(m, prev));
        throw e;
      }
    },
    [token],
  );

  useEffect(
    () =>
      realtime.subscribe((frame) => {
        switch (frame.type) {
          case "message.created":
            setMap((m) =>
              onMessageCreated(m, frame.data, { myMemberId: myIdsRef.current[frame.data.team_id], viewingChannelId: viewingRef.current }),
            );
            break;
          case "channel.read":
          case "channel.pinned":
            setMap((m) => applyState(m, frame.data));
            break;
          case "channel.deleted":
            setMap((m) => removeChannel(m, frame.data.id));
            break;
          case "team.removed":
          case "team.deleted":
            setMap((m) => removeTeam(m, frame.data.team_id));
            break;
        }
      }),
    [],
  );

  const summary = useMemo(() => teamSummary(map, viewingChannelId), [map, viewingChannelId]);
  return { map, summary, seed, apply, markRead, setPinned, reloadSummary: loadSummary };
}
