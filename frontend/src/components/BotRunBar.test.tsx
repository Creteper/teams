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
