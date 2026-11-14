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
    expect(frames.find((f) => f.type === "message.created")).toMatchObject({ type: "message.created", team_id: IDS.tDev });
    expect(frames.at(-1)).toMatchObject({ type: "channel.read" });
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
    const one = await api.getAttachment(token, mockUuid(51));
    expect(Date.parse(one.expires_at)).toBeGreaterThan(Date.now());
    expect(one.kind).toBe("image");
    const many = await api.refreshAttachmentUrls(token, [mockUuid(51), mockUuid(52), "nope", mockUuid(51)]);
    expect(many.items.map((x) => x.id)).toEqual([mockUuid(51), mockUuid(52)]);
    expect(many.missing).toEqual(["nope"]);
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

describe("mock PATCH /me", () => {
  it("改显示名称 1–64 字，推送 member.updated 到所在每个 team", async () => {
    const { db, api } = setup();
    const frames: ServerFrame[] = [];
    db.listeners.add((f) => frames.push(f));
    const { token } = await api.login({ username: "alice", password: "x" });
    const u = await api.updateMe(token, { display_name: "  Alice W  " });
    expect(u.display_name).toBe("Alice W");
    const updated = frames.filter((f) => f.type === "member.updated");
    expect(updated.length).toBeGreaterThanOrEqual(2);
    await expect(api.updateMe(token, { display_name: " " })).rejects.toMatchObject({ code: "validation_failed" });
    await expect(api.login({ username: "alice", password: "ratelimit" })).rejects.toMatchObject({ status: 429, code: "rate_limited" });
  });
});

describe("mock：PATCH 成员角色（§3）", () => {
  it("owner 把成员设为管理员再取消：返回 Member，推送 member.updated", async () => {
    const { db, api } = setup();
    const frames: ServerFrame[] = [];
    db.listeners.add((f) => frames.push(f));
    const { token } = await api.login({ username: "alice", password: "x" });
    const up = await api.updateMemberRole(token, IDS.tDev, IDS.mCarol, { role: "admin" });
    expect(up).toMatchObject({ id: IDS.mCarol, role: "admin" });
    expect(frames.at(-1)).toMatchObject({ type: "member.updated", team_id: IDS.tDev, data: { id: IDS.mCarol, role: "admin" } });
    const down = await api.updateMemberRole(token, IDS.tDev, IDS.mCarol, { role: "member" });
    expect(down?.role).toBe("member");
    const list = (await api.listMembers(token, IDS.tDev)).items;
    expect(list.find((m) => m.id === IDS.mCarol)?.role).toBe("member");
  });
  it("普通成员 → 403；改 owner / bot → 403；不存在 → 404；role 非法 → 400", async () => {
    const { api } = setup();
    const carol = (await api.login({ username: "carol", password: "x" })).token;
    await expect(api.updateMemberRole(carol, IDS.tDev, IDS.mDave, { role: "admin" })).rejects.toMatchObject({ status: 403, code: "forbidden" });
    const alice = (await api.login({ username: "alice", password: "x" })).token;
    const bob = (await api.login({ username: "bob", password: "x" })).token;
    await expect(api.updateMemberRole(bob, IDS.tDev, IDS.mAlice, { role: "member" })).rejects.toMatchObject({ status: 403 });
    await expect(api.updateMemberRole(alice, IDS.tDev, IDS.mHelper, { role: "admin" })).rejects.toMatchObject({ status: 403 });
    await expect(api.updateMemberRole(alice, IDS.tDev, "nope", { role: "admin" })).rejects.toMatchObject({ status: 404 });
    await expect(api.updateMemberRole(alice, IDS.tDev, IDS.mDave, { role: "owner" as "admin" })).rejects.toMatchObject({
      status: 400,
      details: { field: "role" },
    });
  });
});

describe("mock：频道改名 / 删除（§5.1）", () => {
  it("owner 改名：推送 channel.updated；同名 409；空名 400", async () => {
    const { db, api } = setup();
    const frames: ServerFrame[] = [];
    db.listeners.add((f) => frames.push(f));
    const { token } = await api.login({ username: "alice", password: "x" });
    const c = await api.updateChannel(token, IDS.cFrontend, { name: "  web  " });
    expect(c).toMatchObject({ id: IDS.cFrontend, name: "web", is_default: false });
    expect(frames.at(-1)).toMatchObject({ type: "channel.updated", team_id: IDS.tDev, data: { id: IDS.cFrontend, name: "web" } });
    await expect(api.updateChannel(token, IDS.cFrontend, { name: "GENERAL" })).rejects.toMatchObject({ status: 409 });
    await expect(api.updateChannel(token, IDS.cFrontend, { name: " " })).rejects.toMatchObject({ status: 400, details: { field: "name" } });
  });
  it("普通成员只能改自己创建的频道；不能删除", async () => {
    const { api } = setup();
    const carol = (await api.login({ username: "carol", password: "x" })).token;
    await expect(api.updateChannel(carol, IDS.cFrontend, { name: "x1" })).rejects.toMatchObject({ status: 403 });
    const mine = await api.createChannel(carol, IDS.tDev, { name: "carol-room" });
    expect((await api.updateChannel(carol, mine.id, { name: "carol-2" })).name).toBe("carol-2");
    await expect(api.deleteChannel(carol, mine.id)).rejects.toMatchObject({ status: 403 });
  });
  it("owner 删除：推送 channel.deleted {id}；默认频道 403", async () => {
    const { db, api } = setup();
    const frames: ServerFrame[] = [];
    db.listeners.add((f) => frames.push(f));
    const { token } = await api.login({ username: "alice", password: "x" });
    await api.deleteChannel(token, IDS.cRandom);
    expect(frames.at(-1)).toMatchObject({ type: "channel.deleted", team_id: IDS.tDev, data: { id: IDS.cRandom } });
    expect((await api.listChannels(token, IDS.tDev)).items.some((c) => c.id === IDS.cRandom)).toBe(false);
    await expect(api.deleteChannel(token, IDS.cGeneral)).rejects.toMatchObject({ status: 403, code: "forbidden" });
    expect((await api.listChannels(token, IDS.tDev)).items.find((c) => c.id === IDS.cGeneral)?.is_default).toBe(true);
  });
});

describe("mock：bot 资料 / 我的头像", () => {
  it("GET /teams/{tid}/members/{mid}：bot 带 description，用户为 null；不是本 team → 404", async () => {
    const { api } = setup();
    const carol = (await api.login({ username: "carol", password: "x" })).token;
    const bot = await api.getMember(carol, IDS.tDev, IDS.mHelper);
    expect(bot).toMatchObject({ id: IDS.mHelper, type: "bot", role: "bot" });
    expect(bot.description).toContain("AI 助手");
    expect((await api.getMember(carol, IDS.tDev, IDS.mAlice)).description).toBeNull();
    expect((await api.listMembers(carol, IDS.tDev)).items.every((m) => (m.type === "bot" ? typeof m.description === "string" : m.description === null))).toBe(true);
    await expect(api.getMember(carol, IDS.tDev, IDS.mBobDesign)).rejects.toMatchObject({ status: 404 });
  });
  it("PUT /me/avatar：嗅探类型、≤5MB；成功推 member.updated；DELETE 清空", async () => {
    const { db, api } = setup();
    const frames: ServerFrame[] = [];
    db.listeners.add((f) => frames.push(f));
    const { token, user } = await api.login({ username: "alice", password: "x" });
    const png = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])], { type: "image/png" });
    const u = await api.uploadMyAvatar(token, png, "avatar.png");
    expect(u.avatar_url).toMatch(/^data:image\/png;base64,/);
    const upd = frames.filter((f) => f.type === "member.updated");
    expect(upd.length).toBeGreaterThanOrEqual(2); // alice 在两个 team
    expect(upd.every((f) => f.type === "member.updated" && f.data.user_id === user.id && f.data.avatar_url === u.avatar_url)).toBe(true);
    const svg = new Blob(["<svg/>"], { type: "image/png" });
    await expect(api.uploadMyAvatar(token, svg, "x.png")).rejects.toMatchObject({ status: 415 });
    const big = new Blob([new Uint8Array(5 * 1024 * 1024 + 1)]);
    await expect(api.uploadMyAvatar(token, big, "x.png")).rejects.toMatchObject({ status: 413 });
    expect((await api.deleteMyAvatar(token)).avatar_url).toBeNull();
    expect((await api.listMembers(token, IDS.tDev)).items.find((m) => m.user_id === user.id)?.avatar_url).toBeNull();
    // 再删一次：仍 200，但不推送
    const before = frames.length;
    expect((await api.deleteMyAvatar(token)).avatar_url).toBeNull();
    expect(frames.length).toBe(before);
  });
  it("GIF 头像原样保存（不转码）；宽或高 > 4096 → 400 field=avatar", async () => {
    const { api } = setup();
    const { token } = await api.login({ username: "alice", password: "x" });
    const gif = (w: number, h: number) =>
      new Blob([new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, w & 255, w >> 8, h & 255, h >> 8, 0, 0, 0, 0x3b])], { type: "image/gif" });
    expect((await api.uploadMyAvatar(token, gif(200, 120), "a.gif")).avatar_url).toMatch(/^data:image\/gif;base64,R0lGODlh/);
    await expect(api.uploadMyAvatar(token, gif(4097, 10), "big.gif")).rejects.toMatchObject({ status: 400, details: { field: "avatar" } });
  });
});

describe("mock：未读与置顶（§5.7）", () => {
  it("频道列表带本人状态；自己发的、bot_declined 不算未读；@ 我 → has_unread_mention", async () => {
    const { api } = setup();
    const carol = (await api.login({ username: "carol", password: "x" })).token;
    const chans = (await api.listChannels(carol, IDS.tDev)).items;
    const by = (id: string) => chans.find((c) => c.id === id)!;
    expect(chans[0].is_default).toBe(true);
    expect(by(IDS.cGeneral)).toMatchObject({ unread_count: 0, has_unread_mention: false, pinned: false, pinned_at: null });
    expect(by(IDS.cFrontend)).toMatchObject({ unread_count: 2, has_unread_mention: false });
    expect(by(IDS.cRandom)).toMatchObject({ unread_count: 1, has_unread_mention: true });
    // Bob 的 general：Alice @Planner 那条算未读，Planner 的不回复提示不算
    const bob = (await api.login({ username: "bob", password: "x" })).token;
    expect((await api.getChannel(bob, IDS.cGeneral)).unread_count).toBe(1);
  });
  it("POST /read：只前进不后退；省略 seq = 最新；变化才推 channel.read（仅本人）", async () => {
    const { db, api } = setup();
    const got: { f: ServerFrame; only?: string }[] = [];
    db.listeners.add((f, aud) => got.push({ f, only: aud?.only }));
    const { token, user } = await api.login({ username: "carol", password: "x" });
    const ch = await api.getChannel(token, IDS.cFrontend);
    const first = await api.markChannelRead(token, IDS.cFrontend, ch.last_read_seq! + 1);
    expect(first).toMatchObject({ unread_count: 1, last_read_seq: ch.last_read_seq! + 1 });
    const back = await api.markChannelRead(token, IDS.cFrontend, 1);
    expect(back.last_read_seq).toBe(ch.last_read_seq! + 1);
    const all = await api.markChannelRead(token, IDS.cFrontend);
    expect(all).toMatchObject({ unread_count: 0, has_unread_mention: false, last_read_seq: ch.last_message_seq });
    const reads = got.filter((g) => g.f.type === "channel.read");
    expect(reads).toHaveLength(2);
    expect(reads.every((g) => g.only === user.id)).toBe(true);
    await expect(api.markChannelRead(token, IDS.cFrontend, -1)).rejects.toMatchObject({ status: 400 });
  });
  it("PUT/DELETE /pin 幂等，重复置顶保持 pinned_at；变化才推 channel.pinned", async () => {
    const { db, api } = setup();
    const frames: ServerFrame[] = [];
    db.listeners.add((f) => frames.push(f));
    const { token } = await api.login({ username: "carol", password: "x" });
    const a = await api.pinChannel(token, IDS.cRandom);
    expect(a.pinned).toBe(true);
    const b = await api.pinChannel(token, IDS.cRandom);
    expect(b.pinned_at).toBe(a.pinned_at);
    expect((await api.unpinChannel(token, IDS.cRandom)).pinned).toBe(false);
    expect((await api.unpinChannel(token, IDS.cRandom)).pinned).toBe(false);
    expect(frames.filter((f) => f.type === "channel.pinned")).toHaveLength(2);
    // 置顶只影响自己
    const bob = (await api.login({ username: "bob", password: "x" })).token;
    await api.pinChannel(token, IDS.cRandom);
    expect((await api.getChannel(bob, IDS.cRandom)).pinned).toBe(false);
  });
  it("GET /me/unread 跨 team；自己发消息自动已读", async () => {
    const { api } = setup();
    const { token } = await api.login({ username: "alice", password: "x" });
    const items = await api.listMyUnread(token);
    expect(items.some((i) => i.team_id === IDS.tDesign && i.has_unread_mention)).toBe(true);
    expect(items.every((i) => i.unread_count > 0 || i.has_unread_mention)).toBe(true);
    await api.sendMessage(token, IDS.cFrontend, { content: "我也来一条", attachment_ids: [] });
    expect((await api.getChannel(token, IDS.cFrontend)).unread_count).toBe(0);
  });
  it("删除频道后其附件进 missing", async () => {
    const { api } = setup();
    const { token } = await api.login({ username: "alice", password: "x" });
    await api.deleteChannel(token, IDS.cRandom);
    const r = await api.refreshAttachmentUrls(token, [mockUuid(53)]);
    expect(r.missing).toEqual([mockUuid(53)]);
  });
  it("频道名只禁止控制字符：emoji/#/空格可以，换行 400", async () => {
    const { api } = setup();
    const { token } = await api.login({ username: "alice", password: "x" });
    expect((await api.createChannel(token, IDS.tDev, { name: " #发布 🚀 " })).name).toBe("#发布 🚀");
    await expect(api.createChannel(token, IDS.tDev, { name: "a\nb" })).rejects.toMatchObject({ status: 400, details: { field: "name" } });
  });
});

describe("mock：推送订阅（§9.4）", () => {
  const sub = { endpoint: "https://push.example.com/abc", expirationTime: null, keys: { p256dh: "B" + "A".repeat(86), auth: "A".repeat(22) } };
  it("vapid 公钥；新建 201 语义 / 重复 upsert；DELETE 总是成功；关闭推送 → 503 push_disabled", async () => {
    const { db, api } = setup();
    const { token } = await api.login({ username: "alice", password: "x" });
    expect(await api.getVapidPublicKey(token)).toMatchObject({ enabled: true });
    const a = await api.subscribePush(token, sub);
    const b = await api.subscribePush(token, sub);
    expect(b.id).toBe(a.id);
    await expect(api.subscribePush(token, { ...sub, endpoint: "http://x" })).rejects.toMatchObject({ status: 400, details: { field: "endpoint" } });
    await api.unsubscribePush(token, sub.endpoint);
    await api.unsubscribePush(token, sub.endpoint);
    expect(db.pushSubscriptions.size).toBe(0);
    db.pushEnabled = false;
    expect(await api.getVapidPublicKey(token)).toEqual({ enabled: false, public_key: null });
    await expect(api.subscribePush(token, sub)).rejects.toMatchObject({ status: 503, code: "push_disabled" });
  });
});

describe("mock：bot 声明不回复（§7.7）", () => {
  it("正文带 [decline]：插入 bot_declined 提示（reply_to=触发消息）并推 bot.run.declined", async () => {
    const db = createMockDb();
    const api = createMockApi(db, { latencyMs: 0 });
    const rt = createMockRealtime(db, { botReplyMs: 0, pushIntervalMs: 0 });
    const frames: ServerFrame[] = [];
    rt.subscribe((f) => frames.push(f));
    const { token } = await api.login({ username: "alice", password: "x" });
    rt.connect(token);
    const trigger = await api.sendMessage(token, IDS.cGeneral, { content: `<@${IDS.mHelper}> [decline] 帮我订票`, attachment_ids: [] });
    await new Promise((r) => setTimeout(r, 20));
    const notice = frames.find((f) => f.type === "message.created" && f.data.kind === "bot_declined");
    expect(notice && notice.type === "message.created" && notice.data).toMatchObject({ reply_to: trigger.id, mentions: [], trigger_depth: 0, content: "这个问题不在我的服务范围内" });
    const declined = frames.find((f) => f.type === "bot.run.declined");
    expect(declined && declined.type === "bot.run.declined" && declined.data).toMatchObject({ trigger_message_id: trigger.id, bot_member_id: IDS.mHelper });
    expect(frames.some((f) => f.type === "bot.run.completed")).toBe(false);
    rt.disconnect();
  });
});
