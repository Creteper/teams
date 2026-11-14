import type { FrameHandler, RealtimeClient } from "../client";
import type { Message, ReadyData, ServerFrame } from "../types";
import { emit, nextId, nextSeq, type MockDb } from "./db";

/**
 * Mock 实时通道，帧格式同 docs/api.md §8.2：
 * - 转发 mockApi 产生的事件；
 * - 被 @ 的 bot ~1.2s 后回复（带 reply_to、trigger_depth=父+1，正文 @ 回发送者）；
 * - DeployBot 每 45s 往 #general 推一条通知，模拟服务端推送。
 */
export function createMockRealtime(db: MockDb, opts: { botReplyMs?: number; pushIntervalMs?: number } = {}): RealtimeClient {
  const botReplyMs = opts.botReplyMs ?? 1200;
  const pushIntervalMs = opts.pushIntervalMs ?? 45_000;
  const handlers = new Set<FrameHandler>();
  const readyHandlers = new Set<(d: ReadyData) => void>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let connected = false;

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
      sender: { member_id: bot.id, type: "bot", display_name: bot.display_name, avatar_url: bot.avatar_url },
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

  function onFrame(frame: ServerFrame) {
    handlers.forEach((h) => h(frame));
    if (frame.type !== "message.created") return;
    const msg = frame.data;
    if (msg.trigger_depth > 3) return; // §7.4 防循环
    for (const mention of msg.mentions) {
      if (mention.type !== "bot" || mention.member_id === msg.sender.member_id) continue;
      setTimeout(() => {
        const text = msg.content.replace(/<@[^>]+>/g, "").replace(/\s+/g, " ").trim();
        botSay(
          mention.member_id,
          msg.channel_id,
          `<@${msg.sender.member_id}> 收到！（mock 回复）${text ? `你说的是：“${text.slice(0, 60)}”` : "已看到你的附件。"}`,
          msg,
        );
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
    connect() {
      if (connected) return;
      connected = true;
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
