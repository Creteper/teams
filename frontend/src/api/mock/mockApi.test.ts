import { describe, expect, it } from "vitest";
import { ApiError } from "../errors";
import type { ServerFrame } from "../types";
import { createMockDb, IDS } from "./db";
import { createMockApi } from "./mockApi";
import { createMockRealtime } from "./mockRealtime";

function setup() {
  const db = createMockDb();
  const api = createMockApi(db, { latencyMs: 0 });
  return { db, api };
}

describe("mock api（数据形状同 docs/api.md）", () => {
  it("登录后能列出 team、成员（user/bot 区分）和频道", async () => {
    const { api } = setup();
    const { token, user } = await api.login({ username: "alice", password: "anything" });
    expect(token.startsWith("tas_")).toBe(true);
    expect(user.display_name).toBe("Alice");
    const teams = await api.listTeams(token);
    expect(teams.map((t) => t.name)).toContain("TeAms 开发组");
    const dev = teams.find((t) => t.id === IDS.tDev)!;
    expect(dev.my_role).toBe("owner");
    expect(dev.icon_url).toBeNull();
    const members = await api.listMembers(token, dev.id);
    const bot = members.find((m) => m.type === "bot" && m.username === "grok")!;
    expect(bot).toMatchObject({ role: "bot", user_id: null, avatar_shape: "blob", avatar_color: "black" });
    expect(members.filter((m) => m.type === "user").every((m) => m.avatar_shape == null && m.avatar_color == null)).toBe(true);
    const channels = await api.listChannels(token, dev.id);
    expect(channels.some((c) => c.name === "general")).toBe(true);
  });

  it("发消息：服务端解析 <@id> 得到 mentions，seq 递增，推送 message.created", async () => {
    const { db, api } = setup();
    const frames: ServerFrame[] = [];
    db.listeners.add((f) => frames.push(f));
    const { token } = await api.login({ username: "alice", password: "x" });
    const before = db.seq;
    const msg = await api.sendMessage(token, IDS.cGeneral, {
      content: `<@${IDS.mHelper}> 你好 <@not-a-member>`,
      attachment_ids: [],
    });
    expect(msg.seq).toBe(before + 1);
    expect(msg.mentions).toEqual([{ member_id: IDS.mHelper, type: "bot", display_name: "Grok" }]);
    expect(msg.sender.member_id).toBe(IDS.mAlice);
    expect(frames.at(-1)).toMatchObject({ type: "message.created", team_id: IDS.tDev });
  });

  it("空消息报 validation_failed，错误结构带 code", async () => {
    const { api } = setup();
    const { token } = await api.login({ username: "alice", password: "x" });
    await expect(api.sendMessage(token, IDS.cGeneral, { content: " ", attachment_ids: [] })).rejects.toMatchObject({
      status: 400,
      code: "validation_failed",
    });
  });

  it("消息分页：before/after 按 seq 游标", async () => {
    const { api } = setup();
    const { token } = await api.login({ username: "alice", password: "x" });
    const first = await api.listMessages(token, IDS.cGeneral, { limit: 3 });
    expect(first.items).toHaveLength(3);
    expect(first.has_more).toBe(true);
    const older = await api.listMessages(token, IDS.cGeneral, { before: first.items[0].seq, limit: 100 });
    expect(older.items.every((m) => m.seq < first.items[0].seq)).toBe(true);
    const newer = await api.listMessages(token, IDS.cGeneral, { after: first.items[0].seq });
    expect(newer.items.map((m) => m.seq)).toEqual(first.items.slice(1).map((m) => m.seq));
  });

  it("按用户名添加成员：仅 owner/admin，重复报 conflict", async () => {
    const { db, api } = setup();
    const reg = await api.register({ username: "tina", password: "longenough", display_name: "Tina" });
    const { token } = await api.login({ username: "alice", password: "x" });
    const m = await api.addMember(token, IDS.tDev, { username: "tina" });
    expect(m).toMatchObject({ type: "user", user_id: reg.user.id, role: "member" });
    await expect(api.addMember(token, IDS.tDev, { username: "tina" })).rejects.toMatchObject({ code: "conflict" });
    const carol = await api.login({ username: "carol", password: "x" });
    await expect(api.addMember(carol.token, IDS.tDev, { username: "dave" })).rejects.toBeInstanceOf(ApiError);
    expect(db.members.filter((x) => x.team_id === IDS.tDev && x.username === "tina")).toHaveLength(1);
  });

  it("上传：类型/大小前置校验，附件只能被引用一次", async () => {
    const { api } = setup();
    const { token } = await api.login({ username: "alice", password: "x" });
    const png = new File([new Uint8Array(16)], "a.png", { type: "image/png" });
    const att = await api.uploadAttachment(token, IDS.tDev, png);
    expect(att.kind).toBe("image");
    await api.sendMessage(token, IDS.cGeneral, { content: "", attachment_ids: [att.id] });
    await expect(api.sendMessage(token, IDS.cGeneral, { content: "", attachment_ids: [att.id] })).rejects.toMatchObject({
      code: "validation_failed",
    });
    const pdf = new File([new Uint8Array(4)], "a.pdf", { type: "application/pdf" });
    await expect(api.uploadAttachment(token, IDS.tDev, pdf)).rejects.toMatchObject({ status: 415 });
  });

  it("mock 实时：@bot 后 bot 自动回复（reply_to + trigger_depth）", async () => {
    const { db, api } = setup();
    const rt = createMockRealtime(db, { botReplyMs: 0, pushIntervalMs: 0 });
    const frames: ServerFrame[] = [];
    rt.subscribe((f) => frames.push(f));
    rt.connect("x");
    const { token } = await api.login({ username: "alice", password: "x" });
    const msg = await api.sendMessage(token, IDS.cGeneral, { content: `<@${IDS.mHelper}> ping`, attachment_ids: [] });
    await new Promise((r) => setTimeout(r, 10));
    const reply = frames.find((f) => f.type === "message.created" && f.data.reply_to === msg.id);
    expect(reply).toBeTruthy();
    if (reply?.type === "message.created") {
      expect(reply.data.sender.type).toBe("bot");
      expect(reply.data.trigger_depth).toBe(1);
      expect(reply.data.content.startsWith(`<@${IDS.mAlice}>`)).toBe(true);
    }
    rt.disconnect();
  });
});
