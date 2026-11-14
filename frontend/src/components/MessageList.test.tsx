import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Channel, Member, Message } from "../api/types";
import { MessageList } from "./MessageList";

const user = { member_id: "a", type: "user" as const, display_name: "Alice", avatar_url: null, avatar_shape: null, avatar_color: null };
const bot = { member_id: "b", type: "bot" as const, display_name: "Dean", avatar_url: null, avatar_shape: null, avatar_color: null };
const msg = (id: string, seq: number, extra: Partial<Message> = {}): Message => ({
  id,
  seq,
  team_id: "t",
  channel_id: "c",
  kind: "message",
  sender: user,
  content: `消息 ${id}`,
  mentions: [],
  attachments: [],
  reply_to: null,
  trigger_depth: 0,
  created_at: new Date(2026, 10, 15, 10, seq).toISOString(),
  edited_at: null,
  deleted: false,
  ...extra,
});
const channel = { id: "c", team_id: "t", name: "general", topic: "", is_default: true, created_by_member_id: "a", last_message_seq: 9, created_at: "" } as Channel;
const members = [
  { id: "a", type: "user", display_name: "Alice" },
  { id: "b", type: "bot", display_name: "Dean" },
] as unknown as Member[];

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});
afterEach(cleanup);

describe("MessageList", () => {
  it("bot_declined 显示为触发消息下方的灰色系统行（带理由），不单独成一条消息", () => {
    const list = [msg("m1", 1, { content: "<@b> 订会议室" }), msg("d1", 2, { kind: "bot_declined", sender: bot, reply_to: "m1", content: "不在服务范围" })];
    const { container } = render(<MessageList messages={list} members={members} myMemberId="a" channel={channel} />);
    const line = container.querySelector('[data-kind="bot_declined"]') as HTMLElement;
    expect(line.textContent).toContain("Dean 选择不回复：不在服务范围");
    expect(line.textContent).not.toContain("更早的消息");
    // 挂在触发消息那一行里
    expect(line.closest('[data-message-id="m1"]')).toBeTruthy();
  });
  it("理由为空只显示「选择不回复」；触发消息没加载时单独一行并注明", () => {
    const list = [msg("d2", 3, { kind: "bot_declined", sender: bot, reply_to: "old", content: "" })];
    const { container } = render(<MessageList messages={list} members={members} myMemberId="a" channel={channel} />);
    const line = container.querySelector('[data-kind="bot_declined"]') as HTMLElement;
    expect(line.textContent).toContain("Dean 选择不回复");
    expect(line.textContent).not.toContain("：");
    expect(line.textContent).toContain("回复的是更早的消息");
  });
  it("?msg= 高亮：滚到目标消息并加 teams-flash", () => {
    const list = [msg("m1", 1), msg("m2", 2), msg("m3", 3)];
    const { container } = render(<MessageList messages={list} members={members} myMemberId="a" channel={channel} highlightId="m2" />);
    const row = container.querySelector('[data-message-id="m2"]') as HTMLElement;
    expect(row.dataset.highlighted).toBe("true");
    expect(row.className).toContain("teams-flash");
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ block: "center" });
  });
  it("附件已不可用（所在频道已删除）显示占位", () => {
    const att = { id: "att1", kind: "file", filename: "a.pdf", content_type: "application/pdf", size: 10, url: "https://x/a", url_expires_at: "", width: null, height: null, duration_ms: null, thumbnail_url: null };
    const list = [msg("m1", 1, { attachments: [att as never] })];
    render(<MessageList messages={list} members={members} myMemberId="a" channel={channel} goneAttachmentIds={new Set(["att1"])} />);
    expect(screen.getByTestId("attachment-gone").textContent).toContain("附件已不可用");
  });
});
