import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Member } from "../api/types";
import { botRunsReducer } from "../lib/botRuns";
import { BotRunBar } from "./BotRunBar";

const members = [{ id: "b", display_name: "DeployBot", is_bot: true }] as unknown as Member[];
const run = botRunsReducer({}, {
  type: "event",
  event: "failed",
  data: { team_id: "t", channel_id: "c", bot_member_id: "b", trigger_message_id: "m", delivery_id: "d", at: "", reason: "no_webhook" },
  now: 0,
}).d;

describe("BotRunBar 按角色显示失败原因", () => {
  afterEach(cleanup);
  it("所有者/管理员：显示技术原因", () => {
    render(<BotRunBar runs={[run]} members={members} showTechnicalReason onDismiss={() => {}} />);
    expect(screen.getByText(/webhook/)).toBeTruthy();
  });
  it("普通成员：只显示“DeployBot 暂时无法响应”，不出现 webhook", () => {
    const { container } = render(<BotRunBar runs={[run]} members={members} showTechnicalReason={false} onDismiss={() => {}} />);
    expect(screen.getByText("DeployBot 暂时无法响应")).toBeTruthy();
    expect(container.textContent).not.toMatch(/webhook|no_webhook/);
  });
});

describe("BotRunBar：bot 声明不回复", () => {
  afterEach(cleanup);
  it("显示「选择不回复：理由」并可关闭", () => {
    const declined = botRunsReducer({}, {
      type: "event",
      event: "declined",
      data: { team_id: "t", channel_id: "c", bot_member_id: "b", trigger_message_id: "m", delivery_id: "d", at: "", reason: "不在服务范围", decline_message_id: "x" },
      now: 0,
    }).d;
    render(<BotRunBar runs={[declined]} members={members} showTechnicalReason={false} onDismiss={() => {}} />);
    expect(screen.getByText("DeployBot 选择不回复：不在服务范围")).toBeTruthy();
    expect(screen.getByRole("button", { name: /关闭/ })).toBeTruthy();
  });
});

describe("BotRunBar：连接中 → 正在输入", () => {
  afterEach(cleanup);
  const botMembers = [{ id: "b", type: "bot", display_name: "Dean", avatar_url: null, avatar_shape: "blob", avatar_color: "blue" }] as unknown as Member[];
  const base = { team_id: "t", channel_id: "c", bot_member_id: "b", trigger_message_id: "m", delivery_id: "d", at: "" };
  it("乐观 / started：只显示「···」；delivered：头像 + 「Dean 正在输入…」（同一行原地切换）", () => {
    let s = botRunsReducer({}, { type: "optimistic", trigger_message_id: "m", channel_id: "c", bot_member_ids: ["b"], now: 0 });
    const { container, rerender } = render(<BotRunBar runs={Object.values(s)} members={botMembers} showTechnicalReason={false} onDismiss={() => {}} />);
    let row = container.querySelector("[data-phase]") as HTMLElement;
    expect(row.dataset.stage).toBe("connecting");
    expect(row.querySelectorAll(".teams-dot")).toHaveLength(3);
    expect(row.querySelector("svg")).toBeNull();
    expect(screen.queryByText(/正在输入/)).toBeNull();
    expect(screen.getByText("Dean 正在连接…").className).toContain("sr-only");

    s = botRunsReducer(s, { type: "event", event: "started", data: base, now: 1 });
    rerender(<BotRunBar runs={Object.values(s)} members={botMembers} showTechnicalReason={false} onDismiss={() => {}} />);
    expect((container.querySelector("[data-phase]") as HTMLElement).dataset.stage).toBe("connecting");

    s = botRunsReducer(s, { type: "event", event: "delivered", data: { ...base, attempt: 1, status_code: 200 }, now: 2 });
    rerender(<BotRunBar runs={Object.values(s)} members={botMembers} showTechnicalReason={false} onDismiss={() => {}} />);
    row = container.querySelector("[data-phase]") as HTMLElement;
    expect(row.dataset.stage).toBe("typing");
    expect(row.querySelector('[data-avatar="bot"] svg')).toBeTruthy();
    expect(screen.getByTestId("typing-text").textContent).toBe("Dean 正在输入…");
    expect(row.querySelectorAll(".teams-dot")).toHaveLength(0);
  });
  it("retrying 仍显示重试文案", () => {
    const s = botRunsReducer({}, { type: "event", event: "retrying", data: { ...base, attempt: 2 }, now: 0 });
    render(<BotRunBar runs={Object.values(s)} members={botMembers} showTechnicalReason={false} onDismiss={() => {}} />);
    expect(screen.getByText("Dean 正在重试…（第 2 次）")).toBeTruthy();
  });
});

describe("BotRunBar：多个 bot 正在输入时写名字", () => {
  afterEach(cleanup);
  const mk = (id: string, name: string) => ({ id, type: "bot", display_name: name, avatar_url: null, avatar_shape: "blob", avatar_color: "blue" });
  const bots = [mk("a", "Dean"), mk("b", "Planner"), mk("c", "Grok"), mk("d", "一个名字特别特别特别特别长的机器人")] as unknown as Member[];
  const delivered = (ids: string[]) =>
    Object.values(
      ids.reduce(
        (s, id, i) =>
          botRunsReducer(s, {
            type: "event",
            event: "delivered",
            data: { team_id: "t", channel_id: "c", bot_member_id: id, trigger_message_id: "m", delivery_id: `d${i}`, at: "", attempt: 1, status_code: 200 },
            now: i,
          }),
        {} as ReturnType<typeof botRunsReducer>,
      ),
    );
  const textOf = (ids: string[]) => {
    const { container } = render(<BotRunBar runs={delivered(ids)} members={bots} showTechnicalReason={false} onDismiss={() => {}} />);
    const rows = container.querySelectorAll('[data-stage="typing"]');
    expect(rows).toHaveLength(1);
    const t = screen.getByTestId("typing-text");
    expect(t.className).toContain("truncate");
    const out = { text: t.textContent, avatars: rows[0].querySelectorAll('[data-avatar="bot"]').length };
    cleanup();
    return out;
  };
  it("两个：「A 和 B 正在输入…」，合并成一行两个头像", () => {
    expect(textOf(["a", "b"])).toEqual({ text: "Dean 和 Planner 正在输入…", avatars: 2 });
  });
  it("三个及以上：「A、B 等 N 个正在输入…」", () => {
    expect(textOf(["a", "b", "c"]).text).toBe("Dean、Planner 等 3 个正在输入…");
    expect(textOf(["a", "b", "c", "d"]).text).toBe("Dean、Planner 等 4 个正在输入…");
  });
  it("名字太长用省略号截断", () => {
    expect(textOf(["d"]).text).toBe("一个名字特别特别特别特别… 正在输入…");
    expect(textOf(["d", "a"]).text).toBe("一个名字特别特别特别特别… 和 Dean 正在输入…");
  });
});
