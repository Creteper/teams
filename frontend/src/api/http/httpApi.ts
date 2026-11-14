import type { TeamsApi } from "../client";
import { API_BASE_URL, API_PREFIX } from "../config";
import { ApiError } from "../errors";
import type { ApiErrorBody, Message, Page } from "../types";

/**
 * 真实后端实现：fetch + `Authorization: Bearer <SESSION_TOKEN>`，路径按 docs/api.md。
 */
export async function request<T>(
  path: string,
  init: { method?: string; token?: string; body?: unknown; query?: Record<string, string | number | undefined> } = {},
): Promise<T> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(init.query ?? {})) if (v !== undefined) qs.set(k, String(v));
  const url = `${API_BASE_URL}${API_PREFIX}${path}${qs.size ? `?${qs}` : ""}`;
  const isForm = init.body instanceof FormData;
  const headers: Record<string, string> = {};
  if (init.token) headers.Authorization = `Bearer ${init.token}`;
  if (init.body !== undefined && !isForm) headers["Content-Type"] = "application/json";

  let res: Response;
  try {
    res = await fetch(url, {
      method: init.method ?? "GET",
      headers,
      body: init.body === undefined ? undefined : isForm ? (init.body as FormData) : JSON.stringify(init.body),
    });
  } catch (e) {
    throw new ApiError(0, "network_error", `网络错误：${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok) {
    let body: Partial<ApiErrorBody> | null = null;
    try {
      body = (await res.json()) as ApiErrorBody;
    } catch {
      /* 非 JSON 错误体 */
    }
    throw ApiError.fromBody(res.status, body, res.statusText || `HTTP ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** 列表接口可能是数组，也可能是 §0.3 的分页对象；统一取数组（待和后端确认） */
function unwrap<T>(data: T[] | Page<T>): T[] {
  return Array.isArray(data) ? data : data.items;
}

export function createHttpApi(): TeamsApi {
  return {
    register: (input) => request("/auth/register", { method: "POST", body: input }),
    login: (input) => request("/auth/login", { method: "POST", body: input }),
    logout: (token) => request("/auth/logout", { method: "POST", token }),
    me: async (token) => {
      // 文档未明确 /me 返回 User 还是 {user}，两种都兼容
      const data = await request<{ user?: unknown } & Record<string, unknown>>("/me", { token });
      return (data.user ?? data) as never;
    },

    listTeams: async (token) => unwrap(await request("/teams", { token })),
    createTeam: (token, input) => request("/teams", { method: "POST", token, body: input }),
    getTeam: (token, teamId) => request(`/teams/${encodeURIComponent(teamId)}`, { token }),

    listMembers: async (token, teamId) => unwrap(await request(`/teams/${encodeURIComponent(teamId)}/members`, { token })),
    addMember: (token, teamId, input) =>
      request(`/teams/${encodeURIComponent(teamId)}/members`, { method: "POST", token, body: input }),

    listChannels: async (token, teamId) =>
      unwrap(await request(`/teams/${encodeURIComponent(teamId)}/channels`, { token })),
    createChannel: (token, teamId, input) =>
      request(`/teams/${encodeURIComponent(teamId)}/channels`, { method: "POST", token, body: input }),

    listMessages: async (token, channelId, query = {}) => {
      const page = await request<Page<Message>>(`/channels/${encodeURIComponent(channelId)}/messages`, {
        token,
        query: { limit: query.limit, before: query.before, after: query.after },
      });
      // §4.4：before/首屏按 seq 倒序返回，after 正序；前端统一转为正序
      const items = [...page.items].sort((a, b) => a.seq - b.seq);
      return { ...page, items };
    },
    sendMessage: (token, channelId, input) =>
      request(`/channels/${encodeURIComponent(channelId)}/messages`, { method: "POST", token, body: input }),

    uploadAttachment: (token, teamId, file) => {
      const form = new FormData();
      form.append("file", file);
      return request(`/teams/${encodeURIComponent(teamId)}/attachments`, { method: "POST", token, body: form });
    },
  };
}
