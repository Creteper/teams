import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Member } from "../api/types";

const getMember = vi.fn();
const getBot = vi.fn();
vi.mock("../api", () => ({ api: { getMember: (...a: unknown[]) => getMember(...a), getBot: (...a: unknown[]) => getBot(...a) } }));
import { MemberProfileDialog } from "./MemberProfileDialog";

const base = { team_id: "t", avatar_url: null, avatar_shape: null, avatar_color: null, joined_at: "2026-11-01T02:03:00.000Z" };
const user = { ...base, id: "c", type: "user", user_id: "u", bot_id: null, display_name: "Carol", username: "carol", role: "admin", description: null } as Member;
const bot = { ...base, id: "b", type: "bot", user_id: null, bot_id: "bot1", display_name: "Grok", username: "grok", role: "bot", description: "旧描述" } as Member;

describe("成员资料卡（GET /teams/{tid}/members/{mid}）", () => {
  afterEach(() => {
    cleanup();
    getMember.mockReset();
  });
  it("用户：显示名、用户名、角色、加入时间；不显示描述；调成员接口而不是 bot 接口", async () => {
    getMember.mockResolvedValue(user);
    render(<MemberProfileDialog token="tk" member={user} isMe={false} onClose={() => {}} />);
    expect(screen.getByText("Carol")).toBeTruthy();
    expect(screen.getByText("@carol")).toBeTruthy();
    expect(screen.getByText("管理员")).toBeTruthy();
    expect(document.querySelector('[data-field="joined_at"]')?.textContent).toMatch(/2026年11月1日/);
    expect(document.querySelector('[data-field="description"]')).toBeNull();
    expect(getMember).toHaveBeenCalledWith("tk", "t", "c");
    expect(getBot).not.toHaveBeenCalled();
  });
  it("bot：先显示列表里的 description，接口返回后换成最新的", async () => {
    getMember.mockResolvedValue({ ...bot, description: "团队里的 AI 助手" });
    render(<MemberProfileDialog token="tk" member={bot} isMe={false} onClose={() => {}} />);
    expect(screen.getByText("旧描述")).toBeTruthy();
    expect(await screen.findByText("团队里的 AI 助手")).toBeTruthy();
    expect(screen.getByText("Bot")).toBeTruthy();
    expect(getBot).not.toHaveBeenCalled();
  });
  it("bot 描述为空 → 暂无描述；接口失败且没有描述 → 中文提示；已退出 → 标注", async () => {
    getMember.mockResolvedValueOnce({ ...bot, description: "" });
    render(<MemberProfileDialog token="tk" member={{ ...bot, description: "" }} isMe={false} onClose={() => {}} />);
    expect(await screen.findByText("暂无描述")).toBeTruthy();
    cleanup();
    getMember.mockRejectedValueOnce(new Error("网络错误"));
    render(<MemberProfileDialog token="tk" member={{ ...bot, description: null }} isMe={false} onClose={() => {}} />);
    expect(await screen.findByText("资料加载失败：网络错误")).toBeTruthy();
    cleanup();
    getMember.mockResolvedValueOnce({ ...user, deleted: true });
    render(<MemberProfileDialog token="tk" member={user} isMe={false} onClose={() => {}} />);
    expect(await screen.findByText("（已退出）")).toBeTruthy();
  });
});
