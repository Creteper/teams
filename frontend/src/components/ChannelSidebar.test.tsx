import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Channel, Team, User } from "../api/types";
import { ChannelSidebar } from "./ChannelSidebar";

const ch = (id: string, name: string, by: string, is_default = false) =>
  ({ id, team_id: "t", name, topic: "", is_default, created_by_member_id: by, last_message_seq: 0, created_at: "" }) as Channel;
const channels = [ch("g", "general", "o", true), ch("d", "dev", "m"), ch("r", "random", "o")];
const me = { id: "u", username: "me", display_name: "Me", avatar_url: null, created_at: "" } as User;
const team = (role: Team["my_role"]) => ({ id: "t", name: "T", description: "", icon_url: null, owner_user_id: "x", my_member_id: "me", my_role: role, created_at: "" }) as Team;

function setup(role: Team["my_role"], myMemberId: string, onChannelAction = vi.fn()) {
  render(
    <MemoryRouter>
      <ChannelSidebar
        team={team(role)}
        channels={channels}
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
  it("owner：普通频道有 改名 + 删除频道（红字）；默认频道只有改名", async () => {
    const onAction = setup("owner", "o");
    fireEvent.contextMenu(screen.getByText("dev"));
    let items = await screen.findAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual(["改名", "删除频道"]);
    expect(items[1].className).toContain("menu-item--danger");
    fireEvent.click(items[1]);
    await waitFor(() => expect(onAction).toHaveBeenCalledWith(expect.objectContaining({ id: "d" }), "delete"));
    fireEvent.contextMenu(screen.getByText("general"));
    items = await screen.findAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual(["改名"]);
  });
  it("普通成员：只有自己创建的频道有「⋯」（改名）；别人的频道不显示菜单", async () => {
    setup("member", "m");
    expect(screen.getByLabelText("频道 dev 的操作")).toBeTruthy();
    expect(screen.queryByLabelText("频道 general 的操作")).toBeNull();
    expect(screen.queryByLabelText("频道 random 的操作")).toBeNull();
    fireEvent.contextMenu(screen.getByText("random"));
    expect(screen.queryByRole("menu")).toBeNull();
  });
  it("「⋯」触屏常显、桌面悬停/聚焦才显示", () => {
    setup("owner", "o");
    const cls = screen.getByLabelText("频道 dev 的操作").className;
    for (const c of ["opacity-0", "group-hover:opacity-100", "group-focus-within:opacity-100", "pointer-coarse:opacity-100", "[@media(hover:none)]:opacity-100"])
      expect(cls).toContain(c);
  });
});
