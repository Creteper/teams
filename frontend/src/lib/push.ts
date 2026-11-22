import { errorText } from "./errorText";
import type { TeamsApi } from "../api/client";
import { ApiError } from "../api/errors";
import { countsAsUnread } from "./unread";
import { toPlainText } from "./mention";
import type { Message, Team, PushSubscriptionJSONBody } from "../api/types";

/**
 * 浏览器推送（docs/api.md §9.4）：
 * - GET /push/vapid-public-key → enabled=false 时不显示入口；
 * - 只有用户点了开关才 Notification.requestPermission()；
 * - Service Worker 是 public/sw.js（构建后在根目录 /sw.js，scope "/"）；
 * - 订阅 POST /push/subscriptions（PushSubscription.toJSON()），关闭 DELETE /push/subscriptions?endpoint=…。
 */

export const SW_URL = "/sw.js";
export const SW_SCOPE = "/";
/** 记录“哪个用户在这个浏览器开启了推送”：退出登录时服务端会删掉该会话的订阅（§9.4），本地也要跟着清 */
export const PUSH_OWNER_KEY = "teams.push.owner";

/** 国内网络提示：每条失败提示后面都附上 */
export const CHROME_GFW_HINT = "提示：Chrome 的网页推送依赖 Google 服务（FCM），在国内网络下可能订阅失败或收不到通知，可以改用 Edge / Firefox。";

export type PushSupport = { ok: true } | { ok: false; reason: "insecure" | "no-sw" | "no-push" | "no-notification" };

/** 能力检测（不弹任何权限框） */
export function detectPushSupport(win: Partial<Window & typeof globalThis> = globalThis as unknown as Window & typeof globalThis): PushSupport {
  if (win.isSecureContext === false) return { ok: false, reason: "insecure" };
  if (!win.navigator || !("serviceWorker" in win.navigator)) return { ok: false, reason: "no-sw" };
  if (!("PushManager" in win)) return { ok: false, reason: "no-push" };
  if (!("Notification" in win)) return { ok: false, reason: "no-notification" };
  return { ok: true };
}

export function unsupportedText(reason: Exclude<PushSupport, { ok: true }>["reason"]): string {
  if (reason === "insecure") return "当前页面不是 HTTPS（或 localhost），浏览器不允许网页推送。";
  return "当前浏览器不支持网页推送（需要较新的 Chrome / Edge / Firefox，或 Safari 16.4+ 且已添加到主屏幕）。";
}

/** VAPID 公钥 base64url → Uint8Array（applicationServerKey） */
export function base64UrlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const b64 = (s + pad).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export class PushSetupError extends Error {
  readonly kind: "unsupported" | "denied" | "dismissed" | "disabled" | "subscribe" | "server";
  constructor(kind: PushSetupError["kind"], message: string) {
    super(message);
    this.name = "PushSetupError";
    this.kind = kind;
  }
}

/** 订阅 / 服务端错误 → 中文 */
export function pushErrorText(e: unknown): string {
  if (e instanceof PushSetupError) return e.message;
  if (e instanceof ApiError) {
    if (e.status === 503 && e.code === "push_disabled") return "服务器暂未开启推送功能，无法订阅。";
    if (e.status === 400) return `订阅信息被服务器拒绝：${errorText(e)}`;
    if (e.status === 0) return "网络异常，订阅没有保存到服务器，请稍后再试。";
    return `保存订阅失败：${errorText(e)}`;
  }
  return `订阅推送失败。${CHROME_GFW_HINT}`;
}

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration> {
  await navigator.serviceWorker.register(SW_URL, { scope: SW_SCOPE });
  return navigator.serviceWorker.ready;
}

/** The owner flag also covers online notifications when the push provider is unreachable. */
export async function currentPushState(userId: string) {
  const permission = Notification.permission;
  const reg = permission === "granted" && localStorage.getItem(PUSH_OWNER_KEY) === userId
    ? await navigator.serviceWorker.getRegistration(SW_SCOPE) : undefined;
  const sub = await reg?.pushManager.getSubscription().catch(() => null);
  return { on: !!reg, permission, subscribed: !!sub };
}

export const NOTIFICATION_LOG_EVENT = "teams:notification-log";

export function readNotificationLog(userId: string): string {
  try {
    return sessionStorage.getItem("teams.notification-log." + userId) ?? "";
  } catch {
    return "";
  }
}

function recordNotification(userId: string, seq: number, result: string) {
  try {
    const line = `${new Date().toLocaleTimeString("zh-CN", { hour12: false })}  #${seq}  ${result}`;
    const recent = [line, ...readNotificationLog(userId).split("\n").filter(Boolean)].slice(0, 6);
    sessionStorage.setItem("teams.notification-log." + userId, recent.join("\n"));
    window.dispatchEvent(new Event(NOTIFICATION_LOG_EVENT));
  } catch {
    // Logging may be unavailable when the browser restricts storage.
  }
}

export async function notifyOnlineMessage(userId: string, team: Team | undefined, m: Message): Promise<void> {
  if (!countsAsUnread(m, team?.my_member_id)) return;
  const log = (result: string) => recordNotification(userId, m.seq, result);
  try {
    if (localStorage.getItem(PUSH_OWNER_KEY) !== userId) return log("当前账号在此浏览器未开启提醒");
    if (!team?.my_member_id || team.id !== m.team_id) return log("已收到消息，团队成员信息尚未就绪");
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return log("浏览器未授予通知权限");
    const reg = await navigator.serviceWorker?.getRegistration(SW_SCOPE);
    if (!reg) return log("未找到通知服务，请重新开启提醒");
    if (localStorage.getItem(PUSH_OWNER_KEY) !== userId) return;
    const body = toPlainText(m.content, id => m.mentions.find(x => x.member_id === id)?.display_name);
    const action = m.mentions.some(x => x.member_id === team.my_member_id) ? "@了你" : "发了新消息";
    // The same tag merges Web Push and online delivery for this message.
    await reg.showNotification(`${m.sender.display_name} 在 ${team.name} ${action}`, {
      tag: "msg-" + m.id, body: Array.from(body).slice(0, 100).join("") || "[附件]",
      icon: m.sender.avatar_url || "/icons/icon-192.png", badge: "/icons/badge-72.png",
      data: { url: `/teams/${m.team_id}/channels/${m.channel_id}?msg=${m.id}` },
    });
    log("浏览器已接受通知请求");
  } catch (e) {
    log("通知处理失败 · " + (e instanceof DOMException || e instanceof Error ? e.name : "UnknownError"));
  }
}

export async function enablePush(api: TeamsApi, token: string, userId: string, publicKey: string): Promise<"push" | "online"> {
  const support = detectPushSupport();
  if (!support.ok) throw new PushSetupError("unsupported", unsupportedText(support.reason));
  let permission = Notification.permission;
  if (permission === "default") permission = await Notification.requestPermission();
  if (permission === "denied")
    throw new PushSetupError("denied", "通知权限已被拒绝。请点击地址栏左侧的站点信息图标，把「通知」改为允许后再试。");
  if (permission !== "granted") throw new PushSetupError("dismissed", "你没有允许通知权限，频道消息通知未开启。");
  const reg = await registerServiceWorker();
  let sub: PushSubscription;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const subscribe = async () => (await reg.pushManager.getSubscription()) ??
      reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToBytes(publicKey) });
    sub = await Promise.race([subscribe(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Push service timeout")), 8000);
    })]);
  } catch {
    if (Notification.permission !== "granted") throw new PushSetupError("denied", "请先在浏览器站点设置中允许通知。");
    localStorage.setItem(PUSH_OWNER_KEY, userId);
    return "online";
  } finally {
    clearTimeout(timer);
  }
  const json = sub.toJSON() as PushSubscriptionJSONBody;
  await api.subscribePush(token, { endpoint: json.endpoint, expirationTime: json.expirationTime ?? null, keys: json.keys });
  localStorage.setItem(PUSH_OWNER_KEY, userId);
  return "push";
}

/** 关闭：DELETE 服务端（query endpoint，总是 204）→ 浏览器退订 */
export async function disablePush(api: TeamsApi, token: string): Promise<void> {
  const reg = await navigator.serviceWorker.getRegistration(SW_SCOPE);
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  if (sub) {
    await api.unsubscribePush(token, sub.endpoint);
    await sub.unsubscribe().catch(() => false);
  }
  localStorage.removeItem(PUSH_OWNER_KEY);
}
