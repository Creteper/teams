import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../api/errors";

// jsdom 没有 ResizeObserver（HeroUI Tabs / ScrollShadow 用到）
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const getSkill = vi.fn();
vi.mock("../../api", () => ({ api: { getSkill: (...a: unknown[]) => getSkill(...a) } }));

import { SkillDownload } from "./SkillDownload";

const INFO = {
  name: "teams-skill",
  version: "1.0.0",
  install_command: "npx -y http://127.0.0.1:8090/api/v1/downloads/teams-skill.tgz",
  tgz_url: "http://127.0.0.1:8090/api/v1/downloads/teams-skill.tgz",
  versioned_url: "http://127.0.0.1:8090/api/v1/downloads/teams-skill-1.0.0.tgz",
  skill_md_url: "http://127.0.0.1:8090/api/v1/skill/SKILL.md",
  sha256: "ab".repeat(32),
  size_bytes: 12994,
  skill_name: "teams-bot-integration",
  install_path: ".cursor/skills/teams-bot-integration/SKILL.md",
  skill_md_sha256: "cd".repeat(32),
  skill_md: "# TeAms Bot 接入\n\n正文",
};

function setClipboard(writeText: unknown) {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
}

afterEach(() => {
  cleanup();
  getSkill.mockReset();
  vi.unstubAllGlobals();
});

describe("设置 → Skill 下载", () => {
  it("加载中 → 显示版本、大小、安装命令、两个下载按钮和 SKILL.md 预览（请求带 include=skill_md）", async () => {
    let resolve!: (v: unknown) => void;
    getSkill.mockReturnValue(new Promise((r) => (resolve = r)));
    render(<SkillDownload />);
    expect(screen.getByTestId("skill-loading").textContent).toContain("正在获取");
    resolve(INFO);
    await screen.findByTestId("skill-ready");
    expect(getSkill).toHaveBeenCalledWith({ includeSkillMd: true });
    expect(screen.getByTestId("skill-version").textContent).toBe("v1.0.0");
    expect(screen.getByTestId("skill-size").textContent).toContain("12.7 KB");
    expect(screen.getByTestId("skill-install-command").textContent).toBe(INFO.install_command);
    expect(screen.getByTestId("skill-install-hint").textContent).toBe("默认装到 ./.cursor/skills/teams-bot-integration/，可以加 --dir 指定目录，加 --force 覆盖。");
    expect(screen.getByTestId("skill-download-md").getAttribute("href")).toBe(INFO.skill_md_url);
    expect(screen.getByTestId("skill-download-md").getAttribute("download")).toBe("SKILL.md");
    expect(screen.getByTestId("skill-download-tgz").getAttribute("href")).toBe(INFO.tgz_url);
    expect(screen.getByTestId("skill-preview").textContent).toContain("TeAms Bot 接入");
    // 只有一层滚动：预览框不限高、不自带滚动
    expect(screen.getByTestId("skill-preview").className).not.toMatch(/max-h|overflow/);
    // 小标题不做大写转换
    expect(screen.getByText("SKILL.md 预览").className).not.toContain("uppercase");
    // 安装命令换行显示，不截断
    expect(screen.getByTestId("skill-install-command").className).toContain("whitespace-pre-wrap");
    expect(screen.getByTestId("skill-sha256").className).toContain("text-[#b5bac1]");
  });

  it("复制安装命令：写入剪贴板并提示已复制", async () => {
    getSkill.mockResolvedValue(INFO);
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard(writeText);
    render(<SkillDownload />);
    fireEvent.click(await screen.findByRole("button", { name: "复制安装命令" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(INFO.install_command));
    expect(await screen.findByText("已复制 ✓")).toBeTruthy();
  });

  it("复制失败：提示手动复制", async () => {
    getSkill.mockResolvedValue(INFO);
    setClipboard(vi.fn().mockRejectedValue(new Error("denied")));
    render(<SkillDownload />);
    fireEvent.click(await screen.findByRole("button", { name: "复制安装命令" }));
    expect(await screen.findByText("复制失败，请手动选中命令复制。")).toBeTruthy();
  });

  it("出错（503 skill_unavailable）→ 错误提示 + 重试，重试成功后显示内容", async () => {
    getSkill.mockRejectedValueOnce(new ApiError(503, "skill_unavailable", "skill unavailable")).mockResolvedValueOnce(INFO);
    render(<SkillDownload />);
    expect((await screen.findByTestId("skill-error")).textContent).toContain("暂时不可用");
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await screen.findByTestId("skill-ready");
    expect(getSkill).toHaveBeenCalledTimes(2);
  });

  it("没有返回 skill_md 时不显示预览框，提示去下载", async () => {
    getSkill.mockResolvedValue({ ...INFO, skill_md: undefined });
    render(<SkillDownload />);
    await screen.findByTestId("skill-ready");
    expect(screen.queryByTestId("skill-preview")).toBeNull();
    expect(screen.getByText(/没有返回预览内容/)).toBeTruthy();
  });
});
