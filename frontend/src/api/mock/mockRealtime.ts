import type { FrameHandler, RealtimeClient } from "../client";
import type { BotRunEvent, BotRunItem, BotRunStatus, Message, ReadyData, ServerFrame } from "../types";
import { emit, nextId, nextSeq, senderOf, type Audience, type MockDb } from "./db";

/**
 * Mock 实时通道，帧格式同 docs/api.md §8.2：
 * - 转发 mockApi 产生的事件；
 * - 被 @ 的 bot ~1.2s 后回复（带 reply_to、trigger_depth=父+1，正文 @ 回发送者）；
 * - DeployBot 每 45s 往 #general 推一条通知，模拟服务端推送。
 */
export function createMockRealtime(db: MockDb, opts: { botReplyMs?: number; pushIntervalMs?: number } = {}): RealtimeClient {
  const botReplyMs = opts.botReplyMs ?? 3500;
  const pushIntervalMs = opts.pushIntervalMs ?? 45_000;
  const handlers = new Set<FrameHandler>();
  const readyHandlers = new Set<(d: ReadyData) => void>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let connected = false;
  /** 当前连接对应的用户（用于模拟只发给本人 / 除本人外的事件） */
  let userId: string | undefined;

  function botSay(botMemberId: string, channelId: string, content: string, parent: Message | null) {
    const bot = db.members.find((m) => m.id === botMemberId);
    const channel = db.channels.get(channelId);
    if (!bot || !channel) return;
    const mentionIds = [...new Set([...content.matchAll(/<@([0-9A-Za-z_-]+)>/g)].map((m) => m[1]))];
    const msg: Message = {
      id: nextId(db),
      seq: nextSeq(db),
      team_id: channel.team_id,
      channel_id: channelId,
      sender: senderOf(bot),
      kind: "message",
      content,
      mentions: mentionIds
        .map((id) => db.members.find((m) => m.id === id && m.team_id === channel.team_id))
        .filter((m) => !!m)
        .map((m) => ({ member_id: m.id, type: m.type, display_name: m.display_name })),
      attachments: [],
      reply_to: parent?.id ?? null,
      trigger_depth: parent ? parent.trigger_depth + 1 : 1,
      created_at: new Date().toISOString(),
      edited_at: null,
      deleted: false,
    };
    db.messages.push(msg);
    channel.last_message_seq = msg.seq;
    emit(db, { type: "message.created", team_id: channel.team_id, data: msg });
  }

  /** 模拟后端 bot.run.* 生命周期：started → delivered → (回复) → completed；没配 webhook 的 bot 直接 failed(no_webhook) */
  function runEvent(base: Omit<BotRunEvent, "at">, status: BotRunStatus, extra: Partial<BotRunEvent> = {}) {
    const now = new Date().toISOString();
    const { reply_message_id: replyForItem, ...eventExtra } = extra;
    const data: BotRunEvent = { ...base, ...eventExtra, ...(status === "completed" ? { reply_message_id: replyForItem } : {}), at: now };
    const prev = db.botRuns.find((r) => r.delivery_id === base.delivery_id);
    const item: BotRunItem = {
      ...base,
      status,
      attempt: extra.attempt ?? null,
      reason: extra.reason ?? null,
      status_code: extra.status_code ?? null,
      reply_message_id: extra.reply_message_id ?? null,
      started_at: prev?.started_at ?? now,
      updated_at: now,
    };
    db.botRuns = [...db.botRuns.filter((r) => r.delivery_id !== base.delivery_id), item];
    emit(db, { type: `bot.run.${status}`, team_id: base.team_id, data } as ServerFrame);
  }

  /** §7.7 bot 声明不回复：插入 kind=bot_declined 提示消息（reply_to=触发消息），推 message.created + bot.run.declined */
  function botDecline(base: Omit<BotRunEvent, "at">, trigger: Message, reason: string) {
    const bot = db.members.find((m) => m.id === base.bot_member_id);
    const channel = db.channels.get(trigger.channel_id);
    if (!bot || !channel) return;
    const notice: Message = {
      id: nextId(db),
      seq: nextSeq(db),
      kind: "bot_declined",
      team_id: channel.team_id,
      channel_id: channel.id,
      sender: senderOf(bot),
      content: reason,
      mentions: [],
      attachments: [],
      reply_to: trigger.id,
      trigger_depth: 0,
      created_at: new Date().toISOString(),
      edited_at: null,
      deleted: false,
    };
    db.messages.push(notice);
    channel.last_message_seq = notice.seq;
    emit(db, { type: "message.created", team_id: channel.team_id, data: notice });
    runEvent(base, "declined", { decline_message_id: notice.id, reason: reason || null, reply_message_id: notice.id });
  }

  function onFrame(frame: ServerFrame, audience?: Audience) {
    const visible = !audience || ((!audience.only || audience.only === userId) && audience.except !== userId);
    if (visible) handlers.forEach((h) => h(frame));
    if (frame.type !== "message.created") return;
    const msg = frame.data;
    if (msg.trigger_depth > 3) return; // §7.4 防循环
    for (const mention of msg.mentions) {
      if (mention.type !== "bot" || mention.member_id === msg.sender.member_id) continue;
      if (msg.sender.type === "bot") continue; // mock 里 bot 之间不再互相触发
      const base = {
        team_id: msg.team_id,
        channel_id: msg.channel_id,
        bot_member_id: mention.member_id,
        trigger_message_id: msg.id,
        delivery_id: nextId(db),
      };
      if (!db.botsWithWebhook.has(mention.member_id)) {
        setTimeout(() => runEvent(base, "failed", { reason: "no_webhook", status_code: null }), botReplyMs > 0 ? 400 : 0);
        continue;
      }
      setTimeout(() => runEvent(base, "started"), botReplyMs > 0 ? 300 : 0);
      setTimeout(() => runEvent(base, "delivered"), botReplyMs > 0 ? 900 : 0);
      // mock：正文带 [decline] 或“不用回”时 bot 声明不回复（演示 bot_declined 与 BotRunBar 的 declined 状态）
      if (/\[decline\]|不用回/.test(msg.content)) {
        setTimeout(() => botDecline(base, msg, "这个问题不在我的服务范围内"), botReplyMs);
        continue;
      }
      setTimeout(() => {
        const text = msg.content.replace(/<@[^>]+>/g, "").replace(/\s+/g, " ").trim();
        botSay(
          mention.member_id,
          msg.channel_id,
          `<@${msg.sender.member_id}> 收到！（mock 回复）${text ? `你说的是：“${text.slice(0, 60)}”` : "已看到你的附件。"}`,
          msg,
        );
        const reply = db.messages[db.messages.length - 1];
        runEvent(base, "completed", { reply_message_id: reply.id });
      }, botReplyMs);
    }
  }

  function pushTick() {
    const deploy = db.members.find((m) => m.type === "bot" && m.username === "deploybot");
    if (!deploy) return;
    const general = [...db.channels.values()].find((c) => c.team_id === deploy.team_id && c.name === "general");
    if (general) botSay(deploy.id, general.id, `🔔 定时推送：预览环境健康检查通过（${new Date().toLocaleTimeString()}）`, null);
  }

  return {
    connect(token) {
      if (connected) return;
      connected = true;
      userId = db.sessions.get(token);
      if (!userId) {
        const m = /^tas_mock_([a-z0-9_.-]+)_[a-z0-9]+$/.exec(token);
        userId = m ? [...db.users.values()].find((u) => u.username === m[1])?.id : undefined;
      }
      db.listeners.add(onFrame);
      if (pushIntervalMs > 0) timer = setInterval(pushTick, pushIntervalMs);
      const member_ids: Record<string, string> = {};
      queueMicrotask(() => {
        const ready: ReadyData = { member_ids, server_time: new Date().toISOString(), last_seq: db.seq };
        readyHandlers.forEach((h) => h(ready));
        handlers.forEach((h) => h({ type: "ready", data: ready }));
      });
    },
    disconnect() {
      connected = false;
      db.listeners.delete(onFrame);
      if (timer) clearInterval(timer);
      timer = null;
    },
    subscribe(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    onReady(handler) {
      readyHandlers.add(handler);
      return () => readyHandlers.delete(handler);
    },
    onAuthFailed() {
      return () => undefined;
    },
  };
}
