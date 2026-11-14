import type { TeamsApi } from "../client";
import { API_BASE_URL, API_PREFIX } from "../config";
import { ApiError } from "../errors";
import { NETWORK_ERROR_TEXT } from "../../lib/errorText";
import type { ApiErrorBody, Attachment, AttachmentUrlsResponse, BotRunItem, ChannelUserState } from "../types";
import type { UploadOptions } from "../client";
import { isMember } from "../../lib/memberRoles";

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
  } catch {
    // 不把浏览器的英文原文（Failed to fetch 等）带给用户
    throw new ApiError(0, "network_error", NETWORK_ERROR_TEXT);
  }
  if (!res.ok) {
    let body: Partial<ApiErrorBody> | null = null;
    try {
      body = (await res.json()) as ApiErrorBody;
    } catch {
      /* 非 JSON 错误体 */
    }
    throw ApiError.fromBody(res.status, body, res.statusText || `HTTP ${res.status}`, {
      retryAfter: res.headers.get("Retry-After"),
      requestId: res.headers.get("X-Request-Id"),
    });
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
    updateMe: (token, input) => request("/me", { method: "PATCH", token, body: input }),

    listTeams: (token) => request("/teams", { token }),
    createTeam: (token, input) => request("/teams", { method: "POST", token, body: input }),
    getTeam: (token, teamId) => request(`/teams/${encodeURIComponent(teamId)}`, { token }),
    updateTeam: (token, teamId, input) => request(`/teams/${encodeURIComponent(teamId)}`, { method: "PATCH", token, body: input }),
    leaveTeam: (token, teamId) => request(`/teams/${encodeURIComponent(teamId)}/members/me`, { method: "DELETE", token }),

    listMembers: (token, teamId, query = {}) =>
      request(`/teams/${encodeURIComponent(teamId)}/members`, { token, query: { limit: query.limit, cursor: query.cursor } }),
    addMember: (token, teamId, input) =>
      request(`/teams/${encodeURIComponent(teamId)}/members`, { method: "POST", token, body: input }),
    updateChannel: (token, channelId, input) =>
      request(`/channels/${encodeURIComponent(channelId)}`, { method: "PATCH", token, body: input }),
    deleteChannel: (token, channelId) => request(`/channels/${encodeURIComponent(channelId)}`, { method: "DELETE", token }),
    getMember: (token, teamId, memberId) =>
      request(`/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(memberId)}`, { token }),
    getChannel: (token, channelId) => request(`/channels/${encodeURIComponent(channelId)}`, { token }),
    markChannelRead: (token, channelId, seq) =>
      request(`/channels/${encodeURIComponent(channelId)}/read`, { method: "POST", token, body: seq === undefined ? {} : { seq } }),
    pinChannel: (token, channelId) => request(`/channels/${encodeURIComponent(channelId)}/pin`, { method: "PUT", token }),
    unpinChannel: (token, channelId) => request(`/channels/${encodeURIComponent(channelId)}/pin`, { method: "DELETE", token }),
    listMyUnread: async (token) => (await request<{ items: ChannelUserState[] }>("/me/unread", { token })).items,
    getMessage: (token, messageId) => request(`/messages/${encodeURIComponent(messageId)}`, { token }),
    getVapidPublicKey: (token) => request("/push/vapid-public-key", { token }),
    getSkill: (opts) => request("/skill", { query: { include: opts?.includeSkillMd ? "skill_md" : undefined } }),
    subscribePush: (token, sub) => request("/push/subscriptions", { method: "POST", token, body: sub }),
    unsubscribePush: (token, endpoint) => request("/push/subscriptions", { method: "DELETE", token, query: { endpoint } }),
    uploadMyAvatar: (token, file, filename) => {
      const fd = new FormData();
      fd.append("file", file, filename);
      return request("/me/avatar", { method: "PUT", token, body: fd });
    },
    deleteMyAvatar: (token) => request("/me/avatar", { method: "DELETE", token }),
    updateMemberRole: async (token, teamId, memberId, input) => {
      const res = await request<unknown>(`/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(memberId)}`, {
        method: "PATCH",
        token,
        body: input,
      });
      return isMember(res) ? res : null;
    },

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

    uploadAttachment: (token, teamId, file, opts) =>
      uploadWithProgress(`${API_BASE_URL}${API_PREFIX}/teams/${encodeURIComponent(teamId)}/attachments`, token, file, opts),
    listActiveBotRuns: async (token, channelId) => {
      const res = await request<{ items: BotRunItem[] }>(`/channels/${encodeURIComponent(channelId)}/bot-runs`, {
        token,
        query: { active: "true" },
      });
      return res.items;
    },
    previewInvite: (code) => request(`/invites/${encodeURIComponent(code)}`),
    acceptInvite: (token, code) => request(`/invites/${encodeURIComponent(code)}/accept`, { method: "POST", token }),
    createInvite: (token, teamId, input) =>
      request(`/teams/${encodeURIComponent(teamId)}/invites`, { method: "POST", token, body: input }),
    listInvites: (token, teamId) => request(`/teams/${encodeURIComponent(teamId)}/invites`, { token }),
    revokeInvite: (token, teamId, inviteId) =>
      request(`/teams/${encodeURIComponent(teamId)}/invites/${encodeURIComponent(inviteId)}`, { method: "DELETE", token }),
    getAttachment: (token, id) => request(`/attachments/${encodeURIComponent(id)}`, { token }),
    refreshAttachmentUrls: (token, ids) =>
      request<AttachmentUrlsResponse>("/attachments/urls", { method: "POST", token, body: { ids } }),
  };
}

/** XMLHttpRequest 上传：upload.onprogress 报进度，AbortSignal → xhr.abort() */
function uploadWithProgress(url: string, token: string, file: File, opts: UploadOptions = {}): Promise<Attachment> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    xhr.responseType = "json";
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) opts.onProgress?.(e.loaded / e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.response as Attachment);
      else
        reject(
          ApiError.fromBody(xhr.status, xhr.response as Partial<ApiErrorBody> | null, `HTTP ${xhr.status}`, {
            retryAfter: xhr.getResponseHeader("Retry-After"),
            requestId: xhr.getResponseHeader("X-Request-Id"),
          }),
        );
    };
    xhr.onerror = () => reject(new ApiError(0, "network_error", NETWORK_ERROR_TEXT));
    xhr.onabort = () => reject(new DOMException("上传已取消", "AbortError"));
    if (opts.signal) {
      if (opts.signal.aborted) return reject(new DOMException("上传已取消", "AbortError"));
      opts.signal.addEventListener("abort", () => xhr.abort(), { once: true });
    }
    const form = new FormData();
    form.append("file", file);
    xhr.send(form);
  });
}
