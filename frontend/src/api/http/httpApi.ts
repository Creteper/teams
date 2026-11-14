import type { TeamsApi } from "../client";
import { API_BASE_URL, API_PREFIX } from "../config";
import { ApiError } from "../errors";
import type { ApiErrorBody, AttachmentUrl } from "../types";

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

export function createHttpApi(): TeamsApi {
  return {
    register: (input) => request("/auth/register", { method: "POST", body: input }),
    login: (input) => request("/auth/login", { method: "POST", body: input }),
    logout: (token) => request("/auth/logout", { method: "POST", token }),
    me: (token) => request("/me", { token }),

    listTeams: (token) => request("/teams", { token }),
    createTeam: (token, input) => request("/teams", { method: "POST", token, body: input }),
    getTeam: (token, teamId) => request(`/teams/${encodeURIComponent(teamId)}`, { token }),

    listMembers: (token, teamId, query = {}) =>
      request(`/teams/${encodeURIComponent(teamId)}/members`, { token, query: { limit: query.limit, cursor: query.cursor } }),
    addMember: (token, teamId, input) =>
      request(`/teams/${encodeURIComponent(teamId)}/members`, { method: "POST", token, body: input }),

    listChannels: (token, teamId) => request(`/teams/${encodeURIComponent(teamId)}/channels`, { token }),
    createChannel: (token, teamId, input) =>
      request(`/teams/${encodeURIComponent(teamId)}/channels`, { method: "POST", token, body: input }),

    listMessages: (token, channelId, query = {}) =>
      request(`/channels/${encodeURIComponent(channelId)}/messages`, {
        token,
        query: { limit: query.limit, before: query.before, after: query.after },
      }),
    sendMessage: (token, channelId, input) =>
      request(`/channels/${encodeURIComponent(channelId)}/messages`, { method: "POST", token, body: input }),

    uploadAttachment: (token, teamId, file) => {
      const form = new FormData();
      form.append("file", file);
      return request(`/teams/${encodeURIComponent(teamId)}/attachments`, { method: "POST", token, body: form });
    },
    previewInvite: (code) => request(`/invites/${encodeURIComponent(code)}`),
    acceptInvite: (token, code) => request(`/invites/${encodeURIComponent(code)}/accept`, { method: "POST", token }),
    createInvite: (token, teamId, input) =>
      request(`/teams/${encodeURIComponent(teamId)}/invites`, { method: "POST", token, body: input }),
    listInvites: (token, teamId) => request(`/teams/${encodeURIComponent(teamId)}/invites`, { token }),
    revokeInvite: (token, teamId, inviteId) =>
      request(`/teams/${encodeURIComponent(teamId)}/invites/${encodeURIComponent(inviteId)}`, { method: "DELETE", token }),
    getAttachmentUrl: (token, id) => request(`/attachments/${encodeURIComponent(id)}`, { token }),
    refreshAttachmentUrls: async (token, ids) => {
      // 响应形状按 {items:[{id,url,expires_at}]} 处理（待文档确认）
      const res = await request<{ items: AttachmentUrl[] }>("/attachments/urls", { method: "POST", token, body: { ids } });
      return res.items;
    },
  };
}
