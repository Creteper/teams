import { describe, expect, it } from "vitest";
import type { BotRunEvent, Message } from "../api/types";
import { BOT_RUN_TIMEOUT_MS, botRunText, botRunsReducer, isDismissable, type BotRunState } from "./botRuns";

const ev = (extra: Partial<BotRunEvent> = {}): BotRunEvent => ({
  team_id: "t",
  channel_id: "c",
  bot_member_id: "bot",
  trigger_message_id: "m1",
  delivery_id: "d1",
  at: new Date(1000).toISOString(),
  ...extra,
});
const reply = (reply_to: string | null, sender = "bot"): Message => ({
  id: "r",
  seq: 2,
  team_id: "t",
  channel_id: "c",
  sender: { member_id: sender, type: "bot", display_name: "Grok", avatar_url: null, avatar_shape: null, avatar_color: null },
  content: "ok",
  mentions: [],
  attachments: [],
  reply_to,
  trigger_depth: 1,
  created_at: "",
  edited_at: null,
  deleted: false,
});

describe("botRunsReducer", () => {
  it("乐观状态 → started 接管 → delivered → completed 收起", () => {
    let s: BotRunState = {};
    s = botRunsReducer(s, { type: "optimistic", trigger_message_id: "m1", channel_id: "c", bot_member_ids: ["bot"], now: 0 });
    expect(Object.values(s)[0].phase).toBe("optimistic");
    s = botRunsReducer(s, { type: "event", event: "started", data: ev(), now: 10 });
    expect(Object.keys(s)).toEqual(["d1"]);
    expect(s.d1.startedAt).toBe(0); // 沿用乐观开始时间
    s = botRunsReducer(s, { type: "event", event: "delivered", data: ev(), now: 20 });
    expect(s.d1.phase).toBe("delivered");
    s = botRunsReducer(s, { type: "event", event: "completed", data: ev({ reply_message_id: "r" }), now: 30 });
    expect(s).toEqual({});
  });

  it("started 先于 REST 响应到达时不重复加乐观条目", () => {
    let s = botRunsReducer({}, { type: "event", event: "started", data: ev(), now: 0 });
    s = botRunsReducer(s, { type: "optimistic", trigger_message_id: "m1", channel_id: "c", bot_member_ids: ["bot"], now: 1 });
    expect(Object.keys(s)).toEqual(["d1"]);
  });

  it("retrying 显示次数；failed 可关闭并带中文原因", () => {
    let s = botRunsReducer({}, { type: "event", event: "retrying", data: ev({ attempt: 2, reason: "timeout" }), now: 0 });
    expect(botRunText(s.d1, "Grok")).toBe("Grok 正在重试…（第 2 次）");
    s = botRunsReducer(s, { type: "event", event: "failed", data: ev({ reason: "http_error", status_code: 502 }), now: 1 });
    expect(botRunText(s.d1, "Grok")).toBe("Grok 处理失败：对方服务返回错误（HTTP 502）");
    expect(isDismissable(s.d1)).toBe(true);
    // 没有 started 直接 failed(no_webhook)
    const f = botRunsReducer({}, { type: "event", event: "failed", data: ev({ delivery_id: "d9", reason: "no_webhook" }), now: 0 });
    expect(botRunText(f.d9, "DeployBot")).toContain("未配置接收地址");
    expect(botRunsReducer(f, { type: "dismiss", key: "d9" })).toEqual({});
  });

  it("bot 带 reply_to 的回复收起；不带 reply_to 不收起，90 秒后超时", () => {
    let s = botRunsReducer({}, { type: "event", event: "delivered", data: ev(), now: 1000 });
    expect(botRunsReducer(s, { type: "message", message: reply("m1") })).toEqual({});
    s = botRunsReducer(s, { type: "message", message: reply(null) });
    expect(s.d1.phase).toBe("delivered");
    s = botRunsReducer(s, { type: "tick", now: 1000 + BOT_RUN_TIMEOUT_MS - 1 });
    expect(s.d1.phase).toBe("delivered");
    s = botRunsReducer(s, { type: "tick", now: 1000 + BOT_RUN_TIMEOUT_MS });
    expect(botRunText(s.d1, "Grok")).toBe("Grok 暂时没有回复");
  });

  it("hydrate：进入频道/重连时恢复进行中的处理", () => {
    const item = (delivery_id: string, status: "delivered" | "completed") => ({
      ...ev({ delivery_id }),
      status,
      started_at: new Date(500).toISOString(),
      updated_at: new Date(900).toISOString(),
    });
    const s = botRunsReducer({}, { type: "hydrate", items: [item("d1", "delivered"), item("d2", "completed")], now: 0 });
    expect(Object.keys(s)).toEqual(["d1"]);
    expect(s.d1.startedAt).toBe(500); // 90 秒兜底从投递开始算
  });
});

describe("按角色显示失败文案", () => {
  const failed = botRunsReducer({}, {
    type: "event",
    event: "failed",
    data: { team_id: "t", channel_id: "c", bot_member_id: "b", trigger_message_id: "m", delivery_id: "d", at: "", reason: "no_webhook" },
    now: 0,
  }).d;
  it("所有者/管理员看到技术原因", () => {
    expect(botRunText(failed, "DeployBot", { technical: true })).toBe("DeployBot 处理失败：未配置接收地址（webhook）");
  });
  it("普通成员只看到“暂时无法响应”", () => {
    expect(botRunText(failed, "DeployBot", { technical: false })).toBe("DeployBot 暂时无法响应");
  });
  it("非失败状态两种角色文案一致", () => {
    const run = { ...failed, phase: "delivered" as const };
    expect(botRunText(run, "Grok", { technical: false })).toBe(botRunText(run, "Grok", { technical: true }));
  });
});
