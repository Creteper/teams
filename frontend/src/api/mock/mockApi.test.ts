import { describe, expect, it } from "vitest";
import { ApiError } from "../errors";
import type { ServerFrame } from "../types";
import { fetchAllMembers } from "../client";
import { createMockDb, IDS, mockUuid } from "./db";
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
    const teams = (await api.listTeams(token)).items;
    expect(teams.map((t) => t.name)).toContain("TeAms 开发组");
    const dev = teams.find((t) => t.id === IDS.tDev)!;
    expect(dev.my_role).toBe("owner");
    expect(dev.icon_url).toBeNull();
    const members = (await api.listMembers(token, dev.id)).items;
    const bot = members.find((m) => m.type === "bot" && m.username === "grok")!;
    expect(bot).toMatchObject({ role: "bot", user_id: null, avatar_shape: "blob", avatar_color: "black" });
    expect(members.filter((m) => m.type === "user").every((m) => m.avatar_shape == null && m.avatar_color == null)).toBe(true);
    const channels = (await api.listChannels(token, dev.id)).items;
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

  it("消息分页：items 升序，next_cursor 语义（无参/before=最小 seq，after=最大 seq）", async () => {
    const { api } = setup();
    const { token } = await api.login({ username: "alice", password: "x" });
    const first = await api.listMessages(token, IDS.cGeneral, { limit: 3 });
    expect(first.items).toHaveLength(3);
    expect(first.has_more).toBe(true);
    expect(first.items.map((m) => m.seq)).toEqual([...first.items.map((m) => m.seq)].sort((a, b) => a - b));
    expect(first.next_cursor).toBe(String(first.items[0].seq));
    const afterPage = await api.listMessages(token, IDS.cGeneral, { after: first.items[0].seq, limit: 1 });
    expect(afterPage.next_cursor).toBe(String(afterPage.items[0].seq));
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

  it("成员分页：limit + cursor，fetchAllMembers 循环拉完", async () => {
    const { api } = setup();
    const { token } = await api.login({ username: "alice", password: "x" });
    const p1 = await api.listMembers(token, IDS.tDev, { limit: 2 });
    expect(p1.items).toHaveLength(2);
    expect(p1.has_more).toBe(true);
    const p2 = await api.listMembers(token, IDS.tDev, { limit: 2, cursor: p1.next_cursor! });
    expect(p2.items[0].id).not.toBe(p1.items[0].id);
    const allMembers = await fetchAllMembers(api, token, IDS.tDev, 3);
    expect(allMembers.length).toBe((await api.listMembers(token, IDS.tDev)).items.length);
    expect(new Set(allMembers.map((m) => m.id)).size).toBe(allMembers.length);
  });

  it("client_msg_id：格式校验 + 幂等", async () => {
    const { api } = setup();
    const { token } = await api.login({ username: "alice", password: "x" });
    const a = await api.sendMessage(token, IDS.cGeneral, { content: "hi", attachment_ids: [], client_msg_id: "c-abc_1" });
    const b = await api.sendMessage(token, IDS.cGeneral, { content: "hi", attachment_ids: [], client_msg_id: "c-abc_1" });
    expect(b.id).toBe(a.id);
    await expect(
      api.sendMessage(token, IDS.cGeneral, { content: "hi", attachment_ids: [], client_msg_id: "bad id!" }),
    ).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("附件 URL 刷新：单个 + 批量（≤100）", async () => {
    const { api } = setup();
    const { token } = await api.login({ username: "alice", password: "x" });
    const one = await api.getAttachmentUrl(token, mockUuid(51));
    expect(Date.parse(one.expires_at)).toBeGreaterThan(Date.now());
    const many = await api.refreshAttachmentUrls(token, [mockUuid(51), mockUuid(52)]);
    expect(many.map((x) => x.id)).toEqual([mockUuid(51), mockUuid(52)]);
    await expect(api.refreshAttachmentUrls(token, Array.from({ length: 101 }, (_, i) => String(i)))).rejects.toMatchObject({
      status: 400,
    });
  });

  it("添加成员：被加入者本人收 team.joined，其他人收 member.joined", async () => {
    const { db, api } = setup();
    await api.register({ username: "tina", password: "longenough", display_name: "Tina" });
    const tinaLogin = await api.login({ username: "tina", password: "x" });
    const aliceLogin = await api.login({ username: "alice", password: "x" });
    const tinaRt = createMockRealtime(db, { pushIntervalMs: 0 });
    const aliceRt = createMockRealtime(db, { pushIntervalMs: 0 });
    const tinaFrames: string[] = [];
    const aliceFrames: string[] = [];
    tinaRt.subscribe((f) => tinaFrames.push(f.type));
    aliceRt.subscribe((f) => aliceFrames.push(f.type));
    tinaRt.connect(tinaLogin.token);
    aliceRt.connect(aliceLogin.token);
    await api.addMember(aliceLogin.token, IDS.tDev, { username: "tina" });
    expect(tinaFrames).toContain("team.joined");
    expect(tinaFrames).not.toContain("member.joined");
    expect(aliceFrames).toContain("member.joined");
    expect(aliceFrames).not.toContain("team.joined");
    tinaRt.disconnect();
    aliceRt.disconnect();
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

describe("mock 邀请链接", () => {
  it("预览无需登录；有效/过期/作废/用尽；不存在 404", async () => {
    const { api } = setup();
    const ok = await api.previewInvite("OpenLab8");
    expect(ok).toMatchObject({ code: "OpenLab8", valid: true, team: { name: "Open Lab", member_count: 2 } });
    expect(ok.reason).toBeUndefined();
    expect(await api.previewInvite("Expired1")).toMatchObject({ valid: false, reason: "expired" });
    expect(await api.previewInvite("Revoked1")).toMatchObject({ valid: false, reason: "revoked" });
    expect(await api.previewInvite("UsedUp01")).toMatchObject({ valid: false, reason: "exhausted" });
    await expect(api.previewInvite("nope")).rejects.toMatchObject({ status: 404, code: "invite_not_found" });
  });

  it("accept：加入 + uses+1 + team.joined 只给本人；再次 accept 返回 already_member；失效 410", async () => {
    const { db, api } = setup();
    const { token } = await api.login({ username: "alice", password: "x" });
    const rt = createMockRealtime(db, { pushIntervalMs: 0 });
    const frames: string[] = [];
    rt.subscribe((f) => frames.push(f.type));
    rt.connect(token);
    const r = await api.acceptInvite(token, "OpenLab8");
    expect(r.already_member).toBeFalsy();
    expect(r.team.id).toBe(IDS.tOpen);
    expect(r.member.type).toBe("user");
    expect(db.invites.find((i) => i.code === "OpenLab8")!.uses).toBe(4);
    expect(frames).toContain("team.joined");
    expect(frames).not.toContain("member.joined");
    const again = await api.acceptInvite(token, "OpenLab8");
    expect(again.already_member).toBe(true);
    expect(db.invites.find((i) => i.code === "OpenLab8")!.uses).toBe(4);
    const bob = await api.login({ username: "bob", password: "x" });
    await expect(api.acceptInvite(bob.token, "Expired1")).rejects.toMatchObject({ status: 410, code: "invite_expired" });
    await expect(api.acceptInvite(bob.token, "Revoked1")).rejects.toMatchObject({ status: 410, code: "invite_revoked" });
    await expect(api.acceptInvite(bob.token, "UsedUp01")).rejects.toMatchObject({ status: 410, code: "invite_exhausted" });
    rt.disconnect();
  });

  it("创建 / 列表 / 作废（仅 owner/admin），参数范围校验，次数用尽", async () => {
    const { api } = setup();
    const alice = await api.login({ username: "alice", password: "x" });
    const inv = await api.createInvite(alice.token, IDS.tDev, { expires_in_seconds: 1800, max_uses: 1 });
    expect(inv.url_path).toBe(`/invite/${inv.code}`);
    expect(inv.max_uses).toBe(1);
    const forever = await api.createInvite(alice.token, IDS.tDev, {});
    expect(forever).toMatchObject({ expires_at: null, max_uses: null });
    await expect(api.createInvite(alice.token, IDS.tDev, { expires_in_seconds: 10 })).rejects.toMatchObject({ status: 400 });
    await expect(api.createInvite(alice.token, IDS.tDev, { max_uses: 1001 })).rejects.toMatchObject({ status: 400 });
    const carol = await api.login({ username: "carol", password: "x" });
    await expect(api.createInvite(carol.token, IDS.tDev, {})).rejects.toMatchObject({ status: 403 });
    const list = await api.listInvites(alice.token, IDS.tDev);
    expect(list.items[0].id).toBe(forever.id);
    // 用掉唯一一次
    const tina = await api.register({ username: "tina", password: "longenough", display_name: "Tina" });
    await api.acceptInvite(tina.token, inv.code);
    expect(await api.previewInvite(inv.code)).toMatchObject({ valid: false, reason: "exhausted" });
    await api.revokeInvite(alice.token, IDS.tDev, forever.id);
    expect(await api.previewInvite(forever.code)).toMatchObject({ valid: false, reason: "revoked" });
  });
});

describe("mock team 设置 / 退出 / bot 处理状态 / 上传进度", () => {
  async function loginAs(api: ReturnType<typeof createMockApi>, role: "owner" | "admin" | "member") {
    const owner = await api.login({ username: "alice", password: "x" });
    const members = (await api.listMembers(owner.token, IDS.tDev)).items;
    const m = members.find((x) => x.type === "user" && x.role === role)!;
    return api.login({ username: m.username, password: "x" });
  }

  it("PATCH team：仅所有者/管理员，名称 1–50、简介 ≤500（Unicode 计数，去首尾空白），推送 team.updated", async () => {
    const { db, api } = setup();
    const frames: ServerFrame[] = [];
    db.listeners.add((f) => frames.push(f));
    const owner = await loginAs(api, "owner");
    const t = await api.updateTeam(owner.token, IDS.tDev, { name: "  新名字👍  ", description: "  简介  " });
    expect(t).toMatchObject({ name: "新名字👍", description: "简介" });
    expect(frames.some((f) => f.type === "team.updated" && f.data.name === "新名字👍")).toBe(true);
    await expect(api.updateTeam(owner.token, IDS.tDev, { name: "   " })).rejects.toMatchObject({ code: "validation_failed" });
    await expect(api.updateTeam(owner.token, IDS.tDev, { name: "字".repeat(51) })).rejects.toMatchObject({ code: "validation_failed" });
    expect((await api.updateTeam(owner.token, IDS.tDev, { name: "😀".repeat(50) })).name).toBe("😀".repeat(50));
    await expect(api.updateTeam(owner.token, IDS.tDev, { description: "x".repeat(501) })).rejects.toMatchObject({ code: "validation_failed" });
    const member = await loginAs(api, "member");
    await expect(api.updateTeam(member.token, IDS.tDev, { name: "x" })).rejects.toMatchObject({ status: 403 });
  });

  it("退出 team：所有者 409 owner_cannot_leave；成员退出后本人收 team.removed，其他人收 member.left", async () => {
    const { db, api } = setup();
    const owner = await loginAs(api, "owner");
    await expect(api.leaveTeam(owner.token, IDS.tDev)).rejects.toMatchObject({ status: 409, code: "owner_cannot_leave" });
    const member = await loginAs(api, "member");
    const mRt = createMockRealtime(db, { pushIntervalMs: 0 });
    const oRt = createMockRealtime(db, { pushIntervalMs: 0 });
    const mFrames: string[] = [];
    const oFrames: string[] = [];
    mRt.subscribe((f) => mFrames.push(f.type));
    oRt.subscribe((f) => oFrames.push(f.type));
    mRt.connect(member.token);
    oRt.connect(owner.token);
    await api.leaveTeam(member.token, IDS.tDev);
    expect(mFrames).toContain("team.removed");
    expect(mFrames).not.toContain("member.left");
    expect(oFrames).toContain("member.left");
    expect((await api.listTeams(member.token)).items.some((t) => t.id === IDS.tDev)).toBe(false);
    mRt.disconnect();
    oRt.disconnect();
  });

  it("bot.run.*：正常 started→delivered→completed(reply_message_id)；未配 webhook 的 bot failed(no_webhook)", async () => {
    const { db, api } = setup();
    const rt = createMockRealtime(db, { botReplyMs: 0, pushIntervalMs: 0 });
    const frames: ServerFrame[] = [];
    rt.subscribe((f) => frames.push(f));
    const { token } = await api.login({ username: "alice", password: "x" });
    rt.connect(token);
    const msg = await api.sendMessage(token, IDS.cGeneral, { content: `<@${IDS.mHelper}> <@${IDS.mDeploy}> 看下`, attachment_ids: [] });
    await new Promise((r) => setTimeout(r, 20));
    const runs = frames.filter((f) => f.type.startsWith("bot.run."));
    const ok = runs.filter((f) => "bot_member_id" in f.data && f.data.bot_member_id === IDS.mHelper).map((f) => f.type);
    expect(ok).toEqual(["bot.run.started", "bot.run.delivered", "bot.run.completed"]);
    const done = runs.find((f) => f.type === "bot.run.completed");
    if (done?.type === "bot.run.completed") {
      expect(done.data.trigger_message_id).toBe(msg.id);
      expect(done.data.team_id).toBe(IDS.tDev);
      const reply = db.messages.find((m) => m.id === done.data.reply_message_id)!;
      expect(reply.reply_to).toBe(msg.id);
    }
    const failed = runs.filter((f) => "bot_member_id" in f.data && f.data.bot_member_id === IDS.mDeploy);
    expect(failed.map((f) => f.type)).toEqual(["bot.run.failed"]);
    if (failed[0].type === "bot.run.failed") expect(failed[0].data.reason).toBe("no_webhook");
    // 都结束了：进行中列表为空
    expect(await api.listActiveBotRuns(token, IDS.cGeneral)).toEqual([]);
    rt.disconnect();
  });

  it("上传进度回调 + AbortSignal 取消", async () => {
    const { api } = setup();
    const { token } = await api.login({ username: "alice", password: "x" });
    const png = new File([new Uint8Array(16)], "a.png", { type: "image/png" });
    const progress: number[] = [];
    await api.uploadAttachment(token, IDS.tDev, png, { onProgress: (p) => progress.push(p) });
    expect(progress.at(-1)).toBe(1);
    const c = new AbortController();
    c.abort();
    await expect(api.uploadAttachment(token, IDS.tDev, png, { signal: c.signal, onProgress: () => undefined })).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  it("登录密码 wrong / 正文含 [fail] 时模拟失败（截图演示用）", async () => {
    const { api } = setup();
    await expect(api.login({ username: "alice", password: "wrong" })).rejects.toMatchObject({ status: 401 });
    const { token } = await api.login({ username: "alice", password: "x" });
    await expect(api.sendMessage(token, IDS.cGeneral, { content: "hi [fail]", attachment_ids: [] })).rejects.toBeInstanceOf(ApiError);
  });
});
