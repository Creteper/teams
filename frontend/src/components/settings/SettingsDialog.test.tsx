import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// jsdom 没有 ResizeObserver（HeroUI Tabs / ScrollShadow 用到）
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;
// jsdom 没有 Element.getAnimations（Tabs 选中指示条切换动画用到）
Element.prototype.getAnimations ??= () => [];

const logout = vi.fn().mockResolvedValue(undefined);
vi.mock("../../auth/AuthContext", () => ({
  useAuth: () => ({
    logout,
    user: { id: "u", username: "alice", display_name: "Alice", avatar_url: null, created_at: "" },
    updateProfile: vi.fn(),
    uploadAvatar: vi.fn(),
    removeAvatar: vi.fn(),
  }),
  useToken: () => "tok",
}));
vi.mock("../../api", () => ({
  api: {
    getVapidPublicKey: vi.fn().mockResolvedValue({ enabled: false, public_key: null }),
    getSkill: vi.fn().mockResolvedValue({
      name: "teams-skill",
      version: "1.0.0",
      install_command: "npx -y x",
      tgz_url: "x.tgz",
      versioned_url: "x-1.tgz",
      skill_md_url: "SKILL.md",
      sha256: "a",
      size_bytes: 1,
      skill_name: "teams-bot-integration",
      install_path: ".cursor/skills/teams-bot-integration/SKILL.md",
      skill_md_sha256: "b",
    }),
  },
}));

import { SettingsDialog } from "./SettingsDialog";

function setWidth(narrow: boolean) {
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: narrow, media: q, addEventListener() {}, removeEventListener() {} }));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("设置窗口", () => {
  it("左侧垂直 Tabs 三个分类（个人资料 / 通知 / Skill 下载），默认个人资料，可切换", async () => {
    setWidth(false);
    render(<SettingsDialog onClose={() => {}} />);
    const dialog = await screen.findByRole("dialog", { name: "设置" });
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["个人资料", "通知", "Skill 下载"]);
    expect(screen.getByRole("tablist").getAttribute("aria-orientation")).toBe("vertical");
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("settings-title").textContent).toBe("个人资料");
    expect(dialog.querySelector("#profile-name")).toBeTruthy();
    fireEvent.click(tabs[1]);
    await waitFor(() => expect(screen.getByTestId("settings-title").textContent).toBe("通知"));
    // 服务器没开推送：显示说明而不是空白
    expect(await screen.findByTestId("push-hidden")).toBeTruthy();
    fireEvent.click(tabs[2]);
    expect(await screen.findByTestId("skill-ready")).toBeTruthy();
  });

  it("指定 initialTab 时直接打开那一页", async () => {
    setWidth(false);
    render(<SettingsDialog initialTab="skill" onClose={() => {}} />);
    expect((await screen.findByTestId("settings-title")).textContent).toBe("Skill 下载");
  });

  it("右上角 × 关闭", async () => {
    setWidth(false);
    const onClose = vi.fn();
    render(<SettingsDialog onClose={onClose} />);
    fireEvent.click(await screen.findByRole("button", { name: "关闭设置" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("窄屏：先是分类列表；点分类进入内容页，「返回」回到列表", async () => {
    setWidth(true);
    render(<SettingsDialog onClose={() => {}} />);
    await screen.findByRole("dialog", { name: "设置" });
    const nav = screen.getByRole("navigation", { name: "设置分类" });
    expect(nav.className).toContain("flex");
    expect(screen.getByTestId("settings-title").closest("section")!.className).toContain("hidden");
    // 点已选中的「个人资料」也要进入内容页
    fireEvent.click(screen.getAllByRole("tab")[0]);
    await waitFor(() => expect(nav.className).toContain("hidden"));
    expect(screen.getByTestId("settings-title").closest("section")!.className).not.toContain("hidden");
    fireEvent.click(screen.getByRole("button", { name: "返回设置分类" }));
    await waitFor(() => expect(nav.className).not.toContain("hidden"));
  });

  it("选中项直接用底色标出：没有滑动指示块，高亮就在选中的那一项上（初次打开 Skill / 切换后都对）", async () => {
    setWidth(false);
    const { container } = render(<SettingsDialog initialTab="skill" onClose={() => {}} />);
    await screen.findByTestId("settings-title");
    expect(container.ownerDocument.querySelector("[data-slot=tabs-indicator], .tabs__indicator")).toBeNull();
    const tabs = screen.getAllByRole("tab");
    const lit = () => tabs.filter((t) => t.dataset.highlight === "true").map((t) => t.textContent);
    expect(lit()).toEqual(["Skill 下载"]);
    fireEvent.click(tabs[1]);
    await waitFor(() => expect(lit()).toEqual(["通知"]));
  });

  it("窄屏分类列表不预先高亮任何一项", async () => {
    setWidth(true);
    render(<SettingsDialog onClose={() => {}} />);
    await screen.findByRole("dialog", { name: "设置" });
    for (const t of screen.getAllByRole("tab")) {
      expect(t.dataset.highlight).toBeUndefined();
      expect(t.className).not.toContain("data-[selected=true]:bg-");
    }
  });

  it("左侧导航底部红字「退出登录」，点了先弹确认框（AlertDialog），确认后才退出", async () => {
    setWidth(false);
    logout.mockClear();
    render(<SettingsDialog onClose={() => {}} />);
    const btn = await screen.findByTestId("settings-logout");
    expect(btn.textContent).toContain("退出登录");
    expect(btn.className).toContain("text-[#f23f43]");
    // 在导航里、排在所有分类后面
    const nav = screen.getByRole("navigation", { name: "设置分类" });
    expect(nav.contains(btn)).toBe(true);
    expect(screen.getAllByRole("tab").every((t) => t.compareDocumentPosition(btn) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    fireEvent.click(btn);
    const alert = await screen.findByRole("alertdialog");
    expect(logout).not.toHaveBeenCalled();
    fireEvent.click(within(alert).getByRole("button", { name: "退出登录" }));
    await waitFor(() => expect(logout).toHaveBeenCalledTimes(1));
  });

  it("关闭按钮单独占一栏：宽屏内容区右侧留出空间，窄屏内容页有不滚动的顶栏", async () => {
    setWidth(false);
    render(<SettingsDialog onClose={() => {}} />);
    expect((await screen.findByTestId("settings-scroll")).className).toContain("sm:pr-[72px]");
    cleanup();
    setWidth(true);
    render(<SettingsDialog initialTab="profile" onClose={() => {}} />);
    const back = await screen.findByRole("button", { name: "返回设置分类" });
    // 返回按钮在滚动区外面
    expect(screen.getByTestId("settings-scroll").contains(back)).toBe(false);
  });
});
