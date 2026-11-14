import { afterEach, describe, expect, it, vi } from "vitest";
import type { TeamsApi } from "../api/client";
import { ApiError } from "../api/errors";
import { CHROME_GFW_HINT, PUSH_OWNER_KEY, base64UrlToBytes, detectPushSupport, disablePush, enablePush, pushErrorText, unsupportedText } from "./push";

const fakeSub = {
  endpoint: "https://fcm.googleapis.com/fcm/send/abc",
  toJSON: () => ({ endpoint: "https://fcm.googleapis.com/fcm/send/abc", expirationTime: null, keys: { p256dh: "P", auth: "A" } }),
  unsubscribe: vi.fn(async () => true),
};

function installBrowser(opts: { permission: NotificationPermission; request?: NotificationPermission; existing?: boolean; subscribeError?: Error }) {
  const pushManager = {
    getSubscription: vi.fn(async () => (opts.existing ? fakeSub : null)),
    subscribe: vi.fn(async () => {
      if (opts.subscribeError) throw opts.subscribeError;
      return fakeSub;
    }),
  };
  const reg = { pushManager };
  const requestPermission = vi.fn(async () => opts.request ?? opts.permission);
  vi.stubGlobal("Notification", Object.assign(function Notification() {}, { permission: opts.permission, requestPermission }));
  vi.stubGlobal("PushManager", function PushManager() {});
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: { register: vi.fn(async () => reg), ready: Promise.resolve(reg), getRegistration: vi.fn(async () => reg) },
  });
  return { pushManager, requestPermission };
}

const api = () => ({ subscribePush: vi.fn(async () => ({})), unsubscribePush: vi.fn(async () => {}) }) as unknown as TeamsApi & { subscribePush: ReturnType<typeof vi.fn>; unsubscribePush: ReturnType<typeof vi.fn> };

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  // @ts-expect-error 测试清理
  delete navigator.serviceWorker;
});

describe("能力检测与工具函数", () => {
  it("base64url → 字节", () => {
    expect([...base64UrlToBytes("AQID_-8")]).toEqual([1, 2, 3, 255, 239]);
  });
  it("非安全上下文 / 无 SW / 无 PushManager / 无 Notification", () => {
    expect(detectPushSupport({ isSecureContext: false } as never)).toEqual({ ok: false, reason: "insecure" });
    expect(detectPushSupport({ isSecureContext: true, navigator: {} } as never)).toEqual({ ok: false, reason: "no-sw" });
    expect(detectPushSupport({ isSecureContext: true, navigator: { serviceWorker: {} } } as never)).toEqual({ ok: false, reason: "no-push" });
    expect(detectPushSupport({ isSecureContext: true, navigator: { serviceWorker: {} }, PushManager: 1 } as never)).toEqual({ ok: false, reason: "no-notification" });
    expect(detectPushSupport({ isSecureContext: true, navigator: { serviceWorker: {} }, PushManager: 1, Notification: 1 } as never)).toEqual({ ok: true });
    expect(unsupportedText("no-push")).toContain("不支持网页推送");
  });
  it("错误文案：503 push_disabled、400、网络、浏览器订阅失败附 Chrome 提示", () => {
    expect(pushErrorText(ApiError.fromBody(503, { error: { code: "push_disabled", message: "x" } }, ""))).toBe("服务器暂未开启推送功能，无法订阅。");
    expect(pushErrorText(ApiError.fromBody(400, { error: { code: "validation_failed", message: "endpoint 无效" } }, ""))).toContain("endpoint 无效");
    expect(pushErrorText(new Error("AbortError"))).toContain(CHROME_GFW_HINT);
  });
});

describe("enablePush / disablePush", () => {
  it("权限 default → 点击后才请求；授予后订阅并 POST，记录本人", async () => {
    const { pushManager, requestPermission } = installBrowser({ permission: "default", request: "granted" });
    const a = api();
    await enablePush(a, "tok", "u1", "AQID");
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(pushManager.subscribe).toHaveBeenCalledWith(expect.objectContaining({ userVisibleOnly: true }));
    expect(a.subscribePush).toHaveBeenCalledWith("tok", { endpoint: fakeSub.endpoint, expirationTime: null, keys: { p256dh: "P", auth: "A" } });
    expect(localStorage.getItem(PUSH_OWNER_KEY)).toBe("u1");
  });
  it("已拒绝：不再弹框，给出去哪里改的中文提示", async () => {
    const { requestPermission } = installBrowser({ permission: "denied" });
    await expect(enablePush(api(), "tok", "u1", "AQID")).rejects.toMatchObject({ kind: "denied" });
    expect(requestPermission).not.toHaveBeenCalled();
  });
  it("关掉权限弹框（仍为 default）→ dismissed", async () => {
    installBrowser({ permission: "default", request: "default" });
    await expect(enablePush(api(), "tok", "u1", "AQID")).rejects.toMatchObject({ kind: "dismissed" });
  });
  it("浏览器订阅失败（如 FCM 不通）→ subscribe 错误，附 Chrome 国内提示，不 POST", async () => {
    installBrowser({ permission: "granted", subscribeError: new Error("Registration failed - push service error") });
    const a = api();
    const p = enablePush(a, "tok", "u1", "AQID");
    await expect(p).rejects.toMatchObject({ kind: "subscribe" });
    await expect(p).rejects.toThrow(/Google/);
    expect(a.subscribePush).not.toHaveBeenCalled();
  });
  it("503 push_disabled 原样抛出，由界面提示", async () => {
    installBrowser({ permission: "granted" });
    const a = api();
    a.subscribePush.mockRejectedValueOnce(ApiError.fromBody(503, { error: { code: "push_disabled", message: "x" } }, ""));
    await expect(enablePush(a, "tok", "u1", "AQID")).rejects.toMatchObject({ status: 503, code: "push_disabled" });
    expect(localStorage.getItem(PUSH_OWNER_KEY)).toBeNull();
  });
  it("关闭：DELETE 用 endpoint，再浏览器退订", async () => {
    installBrowser({ permission: "granted", existing: true });
    localStorage.setItem(PUSH_OWNER_KEY, "u1");
    const a = api();
    await disablePush(a, "tok");
    expect(a.unsubscribePush).toHaveBeenCalledWith("tok", fakeSub.endpoint);
    expect(fakeSub.unsubscribe).toHaveBeenCalled();
    expect(localStorage.getItem(PUSH_OWNER_KEY)).toBeNull();
  });
});
