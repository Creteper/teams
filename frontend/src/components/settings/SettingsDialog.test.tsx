import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// jsdom 没有 ResizeObserver（HeroUI Tabs / ScrollShadow 用到）
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;
// jsdom 没有 Element.getAnimations（Tabs 选中指示条切换动画用到）
Element.prototype.getAnimations ??= () => [];

vi.mock("../../auth/AuthContext", () => ({
  useAuth: () => ({
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
});
