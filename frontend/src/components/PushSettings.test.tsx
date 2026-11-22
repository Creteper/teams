import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const getVapidPublicKey = vi.fn();
vi.mock("../api", () => ({ api: { getVapidPublicKey: (...a: unknown[]) => getVapidPublicKey(...a) } }));

import { PushSettings } from "./PushSettings";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
  Reflect.deleteProperty(navigator, "serviceWorker");
  getVapidPublicKey.mockReset();
});

describe("PushSettings", () => {
  it("服务器未开启推送（enabled=false）→ 不显示入口", async () => {
    getVapidPublicKey.mockResolvedValue({ enabled: false, public_key: null });
    const { container } = render(<PushSettings token="t" userId="u" />);
    await waitFor(() => expect(getVapidPublicKey).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(container.innerHTML).toBe("");
  });
  it("浏览器不支持 → 显示说明，不显示开关，也不请求权限", async () => {
    getVapidPublicKey.mockResolvedValue({ enabled: true, public_key: "AQID" });
    // jsdom 没有 serviceWorker / PushManager
    render(<PushSettings token="t" userId="u" />);
    expect((await screen.findByTestId("push-unsupported")).textContent).toContain("不支持网页推送");
    expect(screen.queryByTestId("push-switch")).toBeNull();
    expect(screen.getByText(/Google 服务/)).toBeTruthy();
  });
  it("重新打开设置后显示仅在线，允许直接测试本机通知", async () => {
    getVapidPublicKey.mockResolvedValue({ enabled: true, public_key: "AQID" });
    vi.stubGlobal("PushManager", function PushManager() {});
    vi.stubGlobal("Notification", { permission: "granted" });
    const showNotification = vi.fn().mockResolvedValue(undefined);
    const reg = { showNotification, pushManager: { getSubscription: async () => null } };
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: { getRegistration: async () => reg } });
    localStorage.setItem("teams.push.owner", "u");
    render(<PushSettings token="t" userId="u" />);
    expect(await screen.findByText(/仅在线提醒/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "测试本机通知" }));
    await screen.findByText(/浏览器已接受测试请求/);
    expect(showNotification).toHaveBeenCalledTimes(1);
  });
  it("已拒绝权限 → 开关 + 去设置里改的提示", async () => {
    getVapidPublicKey.mockResolvedValue({ enabled: true, public_key: "AQID" });
    vi.stubGlobal("PushManager", function PushManager() {});
    vi.stubGlobal("Notification", Object.assign(function N() {}, { permission: "denied", requestPermission: vi.fn() }));
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: { getRegistration: async () => undefined } });
    render(<PushSettings token="t" userId="u" />);
    expect(await screen.findByText("开启频道消息通知")).toBeTruthy();
    expect(screen.getByTestId("push-denied").textContent).toContain("通知权限已被拒绝");
    // 未选中轨道有可见底色（#4e5058），说明里写明立即生效
    const control = document.querySelector('[data-slot="switch-control"]') as HTMLElement;
    expect(control.className).toContain("[--switch-control-bg:#4e5058]");
    expect(screen.getByText(/包括你正在查看的频道/)).toBeTruthy();
    // @ts-expect-error 测试清理
    delete navigator.serviceWorker;
  });
});
