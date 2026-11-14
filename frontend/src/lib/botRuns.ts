import type { BotRunEvent, BotRunItem, Message } from "../api/types";

/**
 * bot 处理状态（bot.run.* 事件 + 乐观状态 + 90 秒兜底）。纯函数 reducer，便于测试。
 *
 * - 发送方发出含 bot 的消息后先显示乐观状态（optimistic），收到 started 后用 delivery_id 接管；
 * - started / delivered / retrying 显示“正在处理…/正在重试…”；
 * - completed 或该 bot 在同频道 reply_to 这条消息的回复 → 收起；
 * - failed → 显示失败原因，需手动关闭；
 * - 已开始 90 秒仍未完成 → 显示“暂时没有回复”，可关闭。
 */

export type RunPhase = "optimistic" | "started" | "delivered" | "retrying" | "failed" | "timeout";

export interface BotRun {
  /** delivery_id，乐观状态时为 opt:<trigger>:<bot> */
  key: string;
  delivery_id: string | null;
  trigger_message_id: string;
  bot_member_id: string;
  channel_id: string;
  phase: RunPhase;
  startedAt: number;
  attempt?: number | null;
  reason?: string | null;
  status_code?: number | null;
}

export type BotRunState = Record<string, BotRun>;

export const BOT_RUN_TIMEOUT_MS = 90_000;

export type BotRunAction =
  | { type: "optimistic"; trigger_message_id: string; channel_id: string; bot_member_ids: string[]; now: number }
  | { type: "event"; event: "started" | "delivered" | "retrying" | "failed" | "completed"; data: BotRunEvent; now: number }
  | { type: "message"; message: Message }
  | { type: "hydrate"; items: BotRunItem[]; now: number }
  | { type: "tick"; now: number }
  | { type: "dismiss"; key: string };

const optKey = (trigger: string, bot: string) => `opt:${trigger}:${bot}`;

function findKey(state: BotRunState, d: { delivery_id: string; trigger_message_id: string; bot_member_id: string }) {
  if (state[d.delivery_id]) return d.delivery_id;
  const opt = optKey(d.trigger_message_id, d.bot_member_id);
  return state[opt] ? opt : null;
}

function without(state: BotRunState, key: string | null): BotRunState {
  if (!key || !state[key]) return state;
  const next = { ...state };
  delete next[key];
  return next;
}

export function botRunsReducer(state: BotRunState, action: BotRunAction): BotRunState {
  switch (action.type) {
    case "optimistic": {
      const next = { ...state };
      for (const bot of action.bot_member_ids) {
        const key = optKey(action.trigger_message_id, bot);
        // 已有真实状态（started 先于 REST 响应到达）就不再加乐观条目
        if (Object.values(state).some((r) => r.trigger_message_id === action.trigger_message_id && r.bot_member_id === bot)) continue;
        next[key] = {
          key,
          delivery_id: null,
          trigger_message_id: action.trigger_message_id,
          bot_member_id: bot,
          channel_id: action.channel_id,
          phase: "optimistic",
          startedAt: action.now,
        };
      }
      return next;
    }
    case "event": {
      const d = action.data;
      const existingKey = findKey(state, d);
      if (action.event === "completed") return without(state, existingKey);
      const prev = existingKey ? state[existingKey] : undefined;
      const base = without(state, existingKey);
      const run: BotRun = {
        key: d.delivery_id,
        delivery_id: d.delivery_id,
        trigger_message_id: d.trigger_message_id,
        bot_member_id: d.bot_member_id,
        channel_id: d.channel_id,
        phase: action.event,
        startedAt: prev?.startedAt ?? (Date.parse(d.at) || action.now),
        attempt: d.attempt ?? prev?.attempt,
        reason: d.reason ?? (action.event === "failed" ? prev?.reason : undefined),
        status_code: d.status_code ?? null,
      };
      return { ...base, [run.key]: run };
    }
    case "message": {
      const m = action.message;
      if (m.sender.type !== "bot" || !m.reply_to) return state;
      let next = state;
      for (const r of Object.values(state)) {
        if (r.bot_member_id === m.sender.member_id && r.channel_id === m.channel_id && r.trigger_message_id === m.reply_to) {
          next = without(next, r.key);
        }
      }
      return next;
    }
    case "hydrate": {
      let next = { ...state };
      for (const it of action.items) {
        if (it.status === "completed") continue;
        const data: BotRunEvent = {
          team_id: it.team_id,
          channel_id: it.channel_id,
          bot_member_id: it.bot_member_id,
          trigger_message_id: it.trigger_message_id,
          delivery_id: it.delivery_id,
          at: it.started_at,
          attempt: it.attempt,
          next_retry_at: it.next_retry_at,
          reason: it.reason,
          status_code: it.status_code,
        };
        next = botRunsReducer(next, { type: "event", event: it.status, data, now: action.now });
      }
      return next;
    }
    case "tick": {
      let changed = false;
      const next: BotRunState = {};
      for (const [k, r] of Object.entries(state)) {
        const active = r.phase === "optimistic" || r.phase === "started" || r.phase === "delivered" || r.phase === "retrying";
        if (active && action.now - r.startedAt >= BOT_RUN_TIMEOUT_MS) {
          next[k] = { ...r, phase: "timeout" };
          changed = true;
        } else next[k] = r;
      }
      return changed ? next : state;
    }
    case "dismiss":
      return without(state, action.key);
  }
}

const FAIL_TEXT: Record<string, string> = {
  no_webhook: "未配置接收地址（webhook）",
  timeout: "响应超时",
  network_error: "网络错误",
  http_error: "对方服务返回错误",
  invalid_url: "接收地址无效",
  message_deleted: "触发消息已被删除",
};

/** 提示文案；technical=false（普通成员）时失败只显示“暂时无法响应”，不暴露 no_webhook 等技术原因 */
export function botRunText(run: BotRun, botName: string, opts: { technical?: boolean } = {}): string {
  const technical = opts.technical ?? true;
  switch (run.phase) {
    case "optimistic":
    case "started":
    case "delivered":
      return `${botName} 正在处理…`;
    case "retrying":
      return `${botName} 正在重试…${run.attempt ? `（第 ${run.attempt} 次）` : ""}`;
    case "timeout":
      return `${botName} 暂时没有回复`;
    case "failed": {
      if (!technical) return `${botName} 暂时无法响应`;
      const base = FAIL_TEXT[run.reason ?? ""] ?? "处理失败";
      const code = run.reason === "http_error" && run.status_code ? `（HTTP ${run.status_code}）` : "";
      return `${botName} 处理失败：${base}${code}`;
    }
  }
}

export const isDismissable = (run: BotRun) => run.phase === "failed" || run.phase === "timeout";
