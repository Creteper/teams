import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Channel, Member, Message } from "../api/types";
import { mergeMessages } from "../lib/messages";
import { emptySendState, sendReducer, type OutboxItem, type SendAction, type SendState } from "../lib/outbox";
import { MessageList } from "./MessageList";

const me = { member_id: "me", type: "user" as const, display_name: "Me", avatar_url: null, avatar_shape: null, avatar_color: null };
const bob = { ...me, member_id: "bob", display_name: "Bob" };
const channel = { id: "c", team_id: "t", name: "general", topic: "", is_default: true, created_by_member_id: "me", last_message_seq: 0, created_at: "" } as Channel;
const members = [
  { id: "me", type: "user", display_name: "Me" },
  { id: "bob", type: "user", display_name: "Bob" },
] as unknown as Member[];
const msg = (id: string, seq: number, extra: Partial<Message> = {}): Message => ({
  id,
  seq,
  kind: "message",
  team_id: "t",
  channel_id: "c",
  sender: bob,
  content: `消息 ${id}`,
  mentions: [],
  attachments: [],
  reply_to: null,
  trigger_depth: 0,
  created_at: new Date(2026, 10, 15, 10, 0, seq).toISOString(),
  edited_at: null,
  deleted: false,
  ...extra,
});
const pending = (local_id: string, content: string, extra: Partial<OutboxItem> = {}): OutboxItem => ({
  local_id,
  channel_id: "c",
  content,
  attachments: [],
  client_msg_id: `c-${local_id}`,
  status: "sending",
  created_at: new Date(2026, 10, 15, 10, 0, 30).toISOString(),
  sender: me,
  bot_member_ids: [],
  ...extra,
});

/** jsdom 没有 AnimationEvent，React 会监听带前缀的事件名：两种都发 */
function endAnim(node: HTMLElement) {
  for (const t of ["animationend", "webkitAnimationEnd"]) fireEvent(node, new Event(t, { bubbles: true }));
}

let reduce = false;
beforeEach(() => {
  reduce = false;
  Element.prototype.scrollIntoView = vi.fn();
  window.matchMedia = ((q: string) => ({
    matches: q.includes("reduce") ? reduce : false,
    media: q,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  })) as unknown as typeof window.matchMedia;
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});
afterEach(cleanup);

/** 模拟 TeamPage：messages + sendState，两者在同一次更新里改 */
function harness(initial: Message[]) {
  let messages = initial;
  let send: SendState = emptySendState;
  const view = () => (
    <MessageList messages={messages} outbox={send.outbox} keyOf={send.keyOf} members={members} myMemberId="me" channel={channel} onRetrySend={onRetry} onDiscard={onDiscard} />
  );
  const onRetry = vi.fn();
  const onDiscard = vi.fn();
  const r = render(view());
  return {
    onRetry,
    onDiscard,
    apply(actions: SendAction[], incoming: Message[] = []) {
      for (const a of actions) send = sendReducer(send, a);
      messages = mergeMessages(messages, incoming);
      r.rerender(view());
    },
    rowByText: (t: string) => screen.getByText(t).closest("[data-local-key]") as HTMLElement,
    count: (t: string) => screen.queryAllByText(t).length,
  };
}

describe("乐观发送：同一个 DOM 节点从发送中变成真实消息", () => {
  for (const order of ["HTTP 先到", "WebSocket 先到", "HTTP 和 WebSocket 都到"] as const) {
    it(`${order}：key 不变、节点不被替换、不重复、不重播淡入`, () => {
      const h = harness([msg("m1", 1)]);
      h.apply([{ type: "enqueue", item: pending("L1", "你好") }]);
      const node = h.rowByText("你好");
      expect(node.dataset.sendStatus).toBe("sending");
      expect(node.dataset.messageId).toBeUndefined();
      expect(node.className).toContain("teams-msg-in");
      expect(screen.getByTestId("sending-indicator")).toBeTruthy();
      // 淡入播完（jsdom 不会自己触发 animationend）
      endAnim(node);

      const observer = new MutationObserver(() => {});
      observer.observe(node.parentElement!, { childList: true });
      const real = msg("m2", 2, { sender: me, content: "你好" });
      const http: SendAction = { type: "sent", local_id: "L1", message: real };
      const ws: SendAction = { type: "echo", message: real, myMemberId: "me" };
      if (order === "HTTP 先到") h.apply([http], [real]);
      else if (order === "WebSocket 先到") h.apply([ws], [real]);
      else {
        h.apply([ws], [real]);
        h.apply([http], [real]);
      }
      const after = h.rowByText("你好");
      expect(after).toBe(node); // 同一个 DOM 节点
      expect(observer.takeRecords().filter((r) => [...r.removedNodes].includes(node))).toHaveLength(0);
      expect(after.dataset.localKey).toBe("L1");
      expect(after.dataset.messageId).toBe("m2");
      expect(after.dataset.sendStatus).toBeUndefined();
      expect(after.className).not.toContain("teams-msg-in");
      expect(h.count("你好")).toBe(1);
      expect(screen.queryByTestId("sending-indicator")).toBeNull();
      observer.disconnect();
    });
  }

  it("期间别人发了 seq 更大的消息：确认后按 seq 挪到正确位置（节点仍是同一个）", () => {
    const h = harness([msg("m1", 1)]);
    h.apply([{ type: "enqueue", item: pending("L1", "我的") }]);
    const node = h.rowByText("我的");
    // Bob 的 m3 先显示（发送中的排在最后）
    h.apply([], [msg("m3", 3, { content: "Bob 后来的" })]);
    const order = () => [...document.querySelectorAll("[data-local-key]")].map((e) => e.textContent?.includes("我的") ? "mine" : e.getAttribute("data-local-key"));
    expect(order()).toEqual(["m1", "m3", "mine"]);
    // 我的消息 seq=2：挪到 m3 前面
    const real = msg("m2", 2, { sender: me, content: "我的" });
    h.apply([{ type: "sent", local_id: "L1", message: real }], [real]);
    expect(order()).toEqual(["m1", "mine", "m3"]);
    expect(h.rowByText("我的").dataset.localKey).toBe("L1");
    expect(h.count("我的")).toBe(1);
    void node;
  });

  it("失败：保留在原处，标红，可重试 / 删除；重试回到发送中，仍是同一个节点", () => {
    const h = harness([]);
    h.apply([{ type: "enqueue", item: pending("L1", "会失败") }]);
    const node = h.rowByText("会失败");
    endAnim(node);
    h.apply([{ type: "failed", local_id: "L1", error: "网络异常" }]);
    expect(h.rowByText("会失败")).toBe(node);
    expect(node.dataset.sendStatus).toBe("failed");
    expect(screen.getByRole("alert").textContent).toContain("发送失败：网络异常");
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(h.onRetry).toHaveBeenCalledWith("L1");
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    expect(h.onDiscard).toHaveBeenCalledWith("L1");
    h.apply([{ type: "sending", local_id: "L1" }]);
    expect(h.rowByText("会失败")).toBe(node);
    expect(node.dataset.sendStatus).toBe("sending");
    expect(node.className).not.toContain("teams-msg-in");
  });

  it("附件：发送中先显示本地预览", () => {
    const att = { id: "a1", kind: "image", file_name: "p.png", content_type: "image/png", size: 1, url: "https://cdn/p.png", url_expires_at: "", width: 100, height: 80, duration_ms: null, thumbnail_url: null };
    render(
      <MessageList
        messages={[]}
        outbox={[pending("L1", "", { attachments: [att as never] })]}
        localPreviews={{ a1: "blob:local-1" }}
        members={members}
        myMemberId="me"
        channel={channel}
      />,
    );
    expect(screen.getByAltText("p.png").getAttribute("src")).toBe("blob:local-1");
    expect(screen.getByTestId("sending-indicator")).toBeTruthy();
  });
});

describe("淡入动画", () => {
  it("动画没播完时发生重渲染（例如发送成功）：保留动画类不打断，播完后不再加回", () => {
    const h = harness([msg("m1", 1)]);
    h.apply([{ type: "enqueue", item: pending("L1", "快速成功") }]);
    const node = h.rowByText("快速成功");
    const real = msg("m2", 2, { sender: me, content: "快速成功" });
    h.apply([{ type: "sent", local_id: "L1", message: real }], [real]);
    expect(h.rowByText("快速成功")).toBe(node);
    expect(node.className).toContain("teams-msg-in");
    endAnim(node);
    h.apply([], [msg("m3", 3)]);
    expect(node.className).not.toContain("teams-msg-in");
  });
  it("初次加载不播；新收到的播；翻页加载的历史不播", () => {
    const h = harness([msg("m5", 5), msg("m6", 6)]);
    expect(document.querySelectorAll(".teams-msg-in")).toHaveLength(0);
    h.apply([], [msg("m7", 7)]);
    expect(h.rowByText("消息 m7").className).toContain("teams-msg-in");
    h.apply([], [msg("m1", 1), msg("m2", 2)]);
    expect(h.rowByText("消息 m1").className).not.toContain("teams-msg-in");
    expect(h.rowByText("消息 m2").className).not.toContain("teams-msg-in");
  });
  it("设置了减少动态效果：不加动画类", () => {
    reduce = true;
    const h = harness([msg("m1", 1)]);
    h.apply([{ type: "enqueue", item: pending("L1", "安静") }], [msg("m2", 2)]);
    expect(document.querySelectorAll(".teams-msg-in")).toHaveLength(0);
  });
});
