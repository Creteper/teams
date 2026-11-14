import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Member } from "../api/types";
import { MemberList } from "./MemberList";

const mk = (id: string, name: string, role: Member["role"], type: Member["type"] = "user") =>
  ({ id, team_id: "t", type, user_id: type === "user" ? `u${id}` : null, bot_id: null, display_name: name, username: name.toLowerCase(), avatar_url: null, avatar_shape: null, avatar_color: null, role, joined_at: "" }) as Member;
const members = [mk("o", "Alice", "owner"), mk("a", "Bob", "admin"), mk("c", "Carol", "member"), mk("b", "Grok", "bot", "bot")];

describe("成员列表：设为 / 取消管理员入口", () => {
  afterEach(cleanup);
  it("owner：成员和管理员有 ⋯，owner(自己)和 bot 没有", () => {
    render(<MemberList members={members} roles={{ myRole: "owner", myMemberId: "o", onAction: () => {} }} />);
    expect(screen.getByLabelText("Carol 的成员操作")).toBeTruthy();
    expect(screen.getByLabelText("Bob 的成员操作")).toBeTruthy();
    expect(screen.queryByLabelText("Alice 的成员操作")).toBeNull();
    expect(screen.queryByLabelText("Grok 的成员操作")).toBeNull();
  });
  it("普通成员：看不到任何入口", () => {
    render(<MemberList members={members} roles={{ myRole: "member", myMemberId: "c", onAction: () => {} }} />);
    expect(screen.queryAllByLabelText(/的成员操作$/)).toHaveLength(0);
  });
  it("右键成员打开菜单，点「设为管理员」回调 promote", async () => {
    const onAction = vi.fn();
    render(<MemberList members={members} roles={{ myRole: "owner", myMemberId: "o", onAction }} />);
    fireEvent.contextMenu(screen.getByText("Carol"));
    const item = await screen.findByRole("menuitem", { name: "设为管理员" });
    fireEvent.click(item);
    await waitFor(() => expect(onAction).toHaveBeenCalledWith(expect.objectContaining({ id: "c" }), "promote"));
  });
  it("管理员成员的菜单是「取消管理员」", async () => {
    render(<MemberList members={members} roles={{ myRole: "owner", myMemberId: "o", onAction: () => {} }} />);
    fireEvent.contextMenu(screen.getByText("Bob"));
    const item = await screen.findByRole("menuitem", { name: "取消管理员" });
    // 危险色：菜单项是 danger 变体，文字放在 data-slot=label 里（HeroUI 只给 label 上红色）
    expect(item.className).toContain("menu-item--danger");
    const label = item.querySelector('[data-slot="label"]');
    expect(label?.textContent).toBe("取消管理员");
    expect(label?.className).toContain("text-danger");
  });
  it("「⋯」桌面端悬停才出现，触屏（pointer-coarse / hover:none）一直显示", () => {
    render(<MemberList members={members} roles={{ myRole: "owner", myMemberId: "o", onAction: () => {} }} />);
    const cls = screen.getByLabelText("Carol 的成员操作").className;
    expect(cls).toContain("opacity-0");
    expect(cls).toContain("group-hover:opacity-100");
    expect(cls).toContain("pointer-coarse:opacity-100");
    expect(cls).toContain("[@media(hover:none)]:opacity-100");
  });
  it("点了菜单项后角色立刻变化（乐观更新/推送）不会让菜单报错，新菜单变成「取消管理员」", async () => {
    const errors: unknown[] = [];
    const onErr = (e: ErrorEvent) => errors.push(e.error);
    window.addEventListener("error", onErr);
    const roles = { myRole: "owner", myMemberId: "o", onAction: () => {} };
    const { rerender } = render(<MemberList members={members} roles={roles} />);
    fireEvent.contextMenu(screen.getByText("Carol"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "设为管理员" }));
    rerender(<MemberList members={members.map((m) => (m.id === "c" ? { ...m, role: "admin" as const } : m))} roles={roles} />);
    await new Promise((r) => setTimeout(r, 50));
    fireEvent.contextMenu(screen.getByText("Carol"));
    expect(await screen.findByRole("menuitem", { name: "取消管理员" })).toBeTruthy();
    window.removeEventListener("error", onErr);
    expect(errors).toHaveLength(0);
  });
  it("失败提示显示在成员列表顶部，可关闭", () => {
    const onDismiss = vi.fn();
    render(<MemberList members={members} notice="设为管理员失败（Carol）：你没有权限修改这个成员的角色" onDismissNotice={onDismiss} />);
    expect(screen.getByRole("alert").textContent).toContain("你没有权限");
    fireEvent.click(screen.getByLabelText("关闭提示"));
    expect(onDismiss).toHaveBeenCalled();
  });
});
