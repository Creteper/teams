import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import type { Team } from "./api/types";

export function useTeams(token: string) {
  const [teams, setTeams] = useState<Team[]>([]);
  const [loading, setLoading] = useState(true);
  const reload = useCallback(async () => {
    const list = await api.listTeams(token);
    setTeams(list);
    setLoading(false);
    return list;
  }, [token]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { teams, loading, reload };
}
