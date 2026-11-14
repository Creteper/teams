import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

/** 在假的 ServiceWorkerGlobalScope 里执行 public/sw.js，直接调用它挂出来的处理函数 */
function loadSw(clients: { url: string; focused: boolean }[] = []) {
  const listeners: Record<string, (e: unknown) => void> = {};
  const windows = clients.map((c) => ({ ...c, focus: vi.fn(async () => {}), postMessage: vi.fn() }));
  const self = {
    location: { origin: "http://localhost:5190" },
    registration: { showNotification: vi.fn(async () => {}) },
    clients: { matchAll: vi.fn(async () => windows), openWindow: vi.fn(async () => null), claim: vi.fn() },
    skipWaiting: vi.fn(),
    addEventListener: (t: string, fn: (e: unknown) => void) => (listeners[t] = fn),
    __teamsSw: undefined as unknown as {
      notificationFromPayload: (p: unknown) => { title: string; options: Record<string, unknown> };
      handlePush: (e: unknown) => Promise<unknown>;
      handleNotificationClick: (e: unknown) => Promise<unknown>;
    },
  };
  const code = readFileSync(resolve(__dirname, "../../public/sw.js"), "utf8");
  new Function("self", code)(self);
  return { self, sw: self.__teamsSw, listeners, windows };
}

const payload = {
  type: "mention",
  tag: "mention:m1",
  team: { id: "t1", name: "开发组" },
  channel: { id: "c1", name: "general" },
  sender: { member_id: "x", display_name: "Bob", avatar_url: "/api/v1/avatars/a" },
  message: { id: "m1", seq: 9, excerpt: "@Alice 看一下" },
  url: "/teams/t1/channels/c1?msg=m1",
};

describe("Service Worker（public/sw.js）", () => {
  it("注册了 install / activate / push / notificationclick", () => {
    const { listeners } = loadSw();
    expect(Object.keys(listeners).sort()).toEqual(["activate", "install", "notificationclick", "push"]);
  });
  it("mention 载荷 → 标题、正文、tag、图标、点击地址", async () => {
    const { self, sw } = loadSw();
    await sw.handlePush({ data: { json: () => payload } });
    expect(self.registration.showNotification).toHaveBeenCalledWith("Bob 在 开发组 #general @了你", {
      body: "@Alice 看一下",
      tag: "mention:m1",
      icon: "/api/v1/avatars/a",
      badge: "/icons/badge-72.png",
      data: { url: "/teams/t1/channels/c1?msg=m1" },
    });
  });
  it("解析失败也要显示通用通知（userVisibleOnly）", async () => {
    const { self, sw } = loadSw();
    await sw.handlePush({ data: { json: () => { throw new Error("bad"); } } });
    expect(self.registration.showNotification).toHaveBeenCalledWith("TeAms", expect.objectContaining({ data: { url: "/teams" } }));
  });
  it("点击：有本站标签页 → 聚焦并发 teams:navigate；优先已聚焦的", async () => {
    const { sw, windows, self } = loadSw([
      { url: "http://localhost:5190/teams/t1", focused: false },
      { url: "http://localhost:5190/teams/t2", focused: true },
    ]);
    const close = vi.fn();
    await sw.handleNotificationClick({ notification: { close, data: { url: payload.url } } });
    expect(close).toHaveBeenCalled();
    expect(windows[1].focus).toHaveBeenCalled();
    expect(windows[1].postMessage).toHaveBeenCalledWith({ type: "teams:navigate", url: payload.url });
    expect(self.clients.openWindow).not.toHaveBeenCalled();
  });
  it("点击：focus() 被拒（没有用户激活）也照样发 teams:navigate", async () => {
    const { sw, windows } = loadSw([{ url: "http://localhost:5190/teams", focused: true }]);
    windows[0].focus.mockRejectedValueOnce(new Error("InvalidAccessError"));
    await sw.handleNotificationClick({ notification: { close: vi.fn(), data: { url: payload.url } } });
    expect(windows[0].postMessage).toHaveBeenCalledWith({ type: "teams:navigate", url: payload.url });
  });
  it("点击：没有本站标签页 → openWindow 完整地址", async () => {
    const { sw, self } = loadSw([{ url: "https://other.example/", focused: true }]);
    await sw.handleNotificationClick({ notification: { close: vi.fn(), data: { url: payload.url } } });
    expect(self.clients.openWindow).toHaveBeenCalledWith("http://localhost:5190/teams/t1/channels/c1?msg=m1");
  });
});

describe("badge-72.png：透明底、单色白剪影", () => {
  it("文件存在，72×72 RGBA PNG", () => {
    const buf = readFileSync(resolve(process.cwd(), "public/icons/badge-72.png"));
    expect(buf.subarray(1, 4).toString()).toBe("PNG");
    expect(buf.readUInt32BE(16)).toBe(72);
    expect(buf.readUInt32BE(20)).toBe(72);
    expect(buf[25]).toBe(6); // color type 6 = RGBA
  });
});
