import { useCallback, useEffect, useState } from "react";
import { api, realtime } from "./api";
import type { Team } from "./api/types";

/** 按 id 去重合并（accept 结果和 WS team.joined 可能都会到） */
export function upsertTeam(list: Team[], team: Team): Team[] {
  return list.some((t) => t.id === team.id) ? list.map((t) => (t.id === team.id ? team : t)) : [...list, team];
}

/** 我的 team 列表 + 实时更新（team.joined / team.updated / team.removed / team.deleted） */
export function useTeams(token: string) {
  const [teams, setTeams] = useState<Team[]>([]);
  const [loading, setLoading] = useState(true);
  const reload = useCallback(async () => {
    const page = await api.listTeams(token);
    setTeams(page.items);
    setLoading(false);
    return page.items;
  }, [token]);
  useEffect(() => {
    void reload();
  }, [reload]);
  useEffect(
    () =>
      realtime.subscribe((frame) => {
        switch (frame.type) {
          case "team.joined":
          case "team.updated":
            setTeams((prev) => upsertTeam(prev, frame.data));
            break;
          case "team.removed":
          case "team.deleted":
            setTeams((prev) => prev.filter((t) => t.id !== frame.data.team_id));
            break;
        }
      }),
    [],
  );
  const addTeam = useCallback((team: Team) => setTeams((prev) => upsertTeam(prev, team)), []);
  return { teams, loading, reload, addTeam };
}
