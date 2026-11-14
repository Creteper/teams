import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Member } from "../api/types";

const getBot = vi.fn();
vi.mock("../api", () => ({ api: { getBot: (...a: unknown[]) => getBot(...a) } }));
import { MemberProfileDialog } from "./MemberProfileDialog";

const base = { team_id: "t", avatar_url: null, avatar_shape: null, avatar_color: null, joined_at: "2026-11-01T02:03:00.000Z" };
const user = { ...base, id: "c", type: "user", user_id: "u", bot_id: null, display_name: "Carol", username: "carol", role: "admin" } as Member;
const bot = { ...base, id: "b", type: "bot", user_id: null, bot_id: "bot1", display_name: "Grok", username: "grok", role: "bot" } as Member;

describe("成员资料卡", () => {
  afterEach(cleanup);
  it("用户：显示名、用户名、角色、加入时间；不请求 bot 接口", () => {
    render(<MemberProfileDialog token="t" member={user} isMe={false} onClose={() => {}} />);
    expect(screen.getByText("Carol")).toBeTruthy();
    expect(screen.getByText("@carol")).toBeTruthy();
    expect(screen.getByText("管理员")).toBeTruthy();
    expect(document.querySelector('[data-field="joined_at"]')?.textContent).toMatch(/2026年11月1日/);
    expect(document.querySelector('[data-field="description"]')).toBeNull();
    expect(getBot).not.toHaveBeenCalled();
  });
  it("bot：按 bot_id 取 description 显示", async () => {
    getBot.mockResolvedValue({ description: "团队里的 AI 助手" });
    render(<MemberProfileDialog token="t" member={bot} isMe={false} onClose={() => {}} />);
    expect(await screen.findByText("团队里的 AI 助手")).toBeTruthy();
    expect(getBot).toHaveBeenCalledWith("t", "bot1");
    expect(screen.getByText("Bot")).toBeTruthy();
  });
  it("bot 描述为空 → 暂无描述；失败 → 中文提示", async () => {
    getBot.mockResolvedValueOnce({ description: "" });
    render(<MemberProfileDialog token="t" member={bot} isMe={false} onClose={() => {}} />);
    expect(await screen.findByText("暂无描述")).toBeTruthy();
    cleanup();
    getBot.mockRejectedValueOnce(new Error("网络错误"));
    render(<MemberProfileDialog token="t" member={bot} isMe={false} onClose={() => {}} />);
    expect(await screen.findByText("描述加载失败：网络错误")).toBeTruthy();
  });
});
