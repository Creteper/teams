import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Channel, Team, User } from "../api/types";
import type { UnreadMap } from "../lib/unread";
import { ChannelSidebar } from "./ChannelSidebar";

const ch = (id: string, name: string, by: string, is_default = false) =>
  ({ id, team_id: "t", name, topic: "", is_default, created_by_member_id: by, last_message_seq: 0, created_at: "" }) as Channel;
const channels = [ch("g", "general", "o", true), ch("d", "dev", "m"), ch("r", "random", "o")];
const me = { id: "u", username: "me", display_name: "Me", avatar_url: null, created_at: "" } as User;
const team = (role: Team["my_role"]) => ({ id: "t", name: "T", description: "", icon_url: null, owner_user_id: "x", my_member_id: "me", my_role: role, created_at: "" }) as Team;

function setup(role: Team["my_role"], myMemberId: string, onChannelAction = vi.fn(), extra: { channels?: Channel[]; unread?: UnreadMap } = {}) {
  render(
    <MemoryRouter>
      <ChannelSidebar
        team={team(role)}
        channels={extra.channels ?? channels}
        unread={extra.unread}
        currentChannelId="g"
        me={me}
        canManage={role !== "member"}
        myMemberId={myMemberId}
        onChannelAction={onChannelAction}
        onCreateChannel={async () => {}}
        onInvite={() => {}}
        onSettings={() => {}}
        onLeave={() => {}}
        onLogout={() => {}}
        onEditProfile={() => {}}
      />
    </MemoryRouter>,
  );
  return onChannelAction;
}

describe("频道菜单", () => {
  afterEach(cleanup);
  it("owner：普通频道有 置顶 + 改名 + 删除频道（红字）；默认频道没有删除", async () => {
    const onAction = setup("owner", "o");
    fireEvent.contextMenu(screen.getByText("dev"));
    let items = await screen.findAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual(["置顶", "改名", "删除频道"]);
    expect(items[2].className).toContain("menu-item--danger");
    fireEvent.click(items[2]);
    await waitFor(() => expect(onAction).toHaveBeenCalledWith(expect.objectContaining({ id: "d" }), "delete"));
    fireEvent.contextMenu(screen.getByText("general"));
    items = await screen.findAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual(["置顶", "改名"]);
  });
  it("普通成员：每个频道都有「⋯」；别人的频道只有置顶", async () => {
    const onAction = setup("member", "m");
    expect(screen.getByLabelText("频道 dev 的操作")).toBeTruthy();
    expect(screen.getByLabelText("频道 general 的操作")).toBeTruthy();
    fireEvent.contextMenu(screen.getByText("random"));
    const items = await screen.findAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual(["置顶"]);
    fireEvent.click(items[0]);
    await waitFor(() => expect(onAction).toHaveBeenCalledWith(expect.objectContaining({ id: "r" }), "pin"));
  });
  it("「⋯」触屏常显、桌面悬停/聚焦才显示", () => {
    setup("owner", "o");
    const cls = screen.getByLabelText("频道 dev 的操作").className;
    for (const c of ["opacity-0", "group-hover:opacity-100", "group-focus-within:opacity-100", "pointer-coarse:opacity-100", "[@media(hover:none)]:opacity-100"])
      expect(cls).toContain(c);
  });
});

describe("未读与置顶", () => {
  afterEach(cleanup);
  const unread: UnreadMap = {
    d: { channel_id: "d", team_id: "t", unread_count: 1000, has_unread_mention: false, last_read_seq: 0, pinned: false, pinned_at: null },
    r: { channel_id: "r", team_id: "t", unread_count: 3, has_unread_mention: true, last_read_seq: 0, pinned: true, pinned_at: "2026-11-15T01:00:00Z" },
    g: { channel_id: "g", team_id: "t", unread_count: 5, has_unread_mention: true, last_read_seq: 0, pinned: false, pinned_at: null },
  };
  it("未读角标：普通灰色、@ 我红色「@」；1000 显示 999+；当前打开的频道不显示", () => {
    setup("member", "m", vi.fn(), { unread });
    const row = (id: string) => document.querySelector(`li[data-channel-id="${id}"]`) as HTMLElement;
    expect(row("d").dataset.unread).toBe("true");
    expect(row("d").querySelector('[data-testid="unread-badge"]')?.textContent).toBe("999+");
    expect(row("r").dataset.unread).toBe("mention");
    const b = row("r").querySelector('[data-testid="unread-badge"]') as HTMLElement;
    expect(b.dataset.mention).toBe("true");
    expect(b.textContent).toContain("@");
    expect(row("g").dataset.unread).toBeUndefined();
    expect(row("g").querySelector('[data-testid="unread-badge"]')).toBeNull();
  });
  it("置顶频道单独成组排在最前，带 📌，菜单是「取消置顶」", async () => {
    setup("member", "m", vi.fn(), { unread });
    expect(screen.getByTestId("pinned-heading").textContent).toContain("置顶");
    const pinned = screen.getByTestId("pinned-list");
    expect([...pinned.querySelectorAll("li[data-channel-id]")].map((li) => li.getAttribute("data-channel-id"))).toEqual(["r"]);
    expect(pinned.querySelector('[data-testid="pin-icon"]')).toBeTruthy();
    fireEvent.contextMenu(screen.getByText("random"));
    const items = await screen.findAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual(["取消置顶"]);
  });
  it("没有置顶时不显示置顶分组", () => {
    setup("member", "m");
    expect(screen.queryByTestId("pinned-heading")).toBeNull();
  });
});
