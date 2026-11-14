import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Attachment, Channel, Member, Message, MessageSender } from "../api/types";
import { parseContent } from "../lib/mention";
import { attachDeclines, formatTime, groupMessages, isDeclined } from "../lib/messages";
import type { OutboxItem } from "../lib/outbox";
import { BotBadge, MemberAvatar } from "./MemberAvatar";
import { useStickToBottom } from "./useStickToBottom";

interface Row {
  key: string;
  sender: MessageSender;
  created_at: string;
  content: string;
  deleted: boolean;
  attachments: Attachment[];
  mentionIds: string[];
  mentionNames: Map<string, string>;
  outbox?: OutboxItem;
  declined?: boolean;
  reply_to?: string | null;
}

function toRow(m: Message): Row {
  return {
    declined: isDeclined(m),
    reply_to: m.reply_to,
    key: m.id,
    sender: m.sender,
    created_at: m.created_at,
    content: m.content,
    deleted: m.deleted,
    attachments: m.attachments,
    mentionIds: m.mentions.map((x) => x.member_id),
    mentionNames: new Map(m.mentions.map((x) => [x.member_id, x.display_name])),
  };
}

/**
 * 消息流：头像 + 名字 + 时间，连续消息合并；@ 我的消息整行淡黄底 + 左侧黄条；
 * 顶部频道欢迎块；加载骨架屏；发送失败可重发/删除；媒体加载失败占位 + 重试；向上滚动加载更早消息并保持位置。
 */
export function MessageList({
  messages,
  outbox = [],
  members,
  myMemberId,
  channel,
  initialLoading = false,
  hasMore = false,
  loadingOlder = false,
  onLoadOlder,
  onMediaError,
  onMediaRetry,
  onRetrySend,
  onDiscard,
  highlightId,
  goneAttachmentIds,
}: {
  messages: Message[];
  outbox?: OutboxItem[];
  members: Member[];
  myMemberId: string;
  channel: Channel;
  initialLoading?: boolean;
  hasMore?: boolean;
  loadingOlder?: boolean;
  onLoadOlder?(): void;
  /** 图片/视频首次加载失败（签名 URL 可能过期）：自动刷新一次 */
  onMediaError?(attachmentId: string): void;
  /** 用户点“重试”：强制刷新该附件 URL */
  onMediaRetry?(attachmentId: string): void;
  onRetrySend?(localId: string): void;
  onDiscard?(localId: string): void;
  /** ?msg= 定位：滚到这条消息并高亮几秒 */
  highlightId?: string | null;
  /** 已确认不可访问的附件（如所在频道已删除，§5.1）：显示“附件已不可用”，不再重试 */
  goneAttachmentIds?: ReadonlySet<string>;
}) {
  // 贴底：内容变高或可视区变矮（状态条、上传卡片）时，原本在底部就跟到底
  const { scrollRef, contentRef, atBottomRef: stickRef, onScroll: trackScroll, stickIfNeeded: stick, scrollToBottom } =
    useStickToBottom();
  const [preview, setPreview] = useState<Attachment | null>(null);
  const byId = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);
  // bot 声明不回复的提示挂到触发消息下面（§7.7）
  const { main, byTrigger } = useMemo(() => attachDeclines(messages), [messages]);
  const groups = useMemo(() => groupMessages(main), [main]);

  // 头部插入更早消息时保持滚动位置
  const firstId = messages[0]?.id;
  const prevFirstIdRef = useRef<string | undefined>(undefined);
  const prevHeightRef = useRef(0);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && prevFirstIdRef.current && firstId !== prevFirstIdRef.current && !stickRef.current) {
      el.scrollTop += el.scrollHeight - prevHeightRef.current;
    }
    prevFirstIdRef.current = firstId;
    if (el) prevHeightRef.current = el.scrollHeight;
  });

  useEffect(() => {
    stick();
  }, [messages.length, outbox.length, stick]);
  // 进入频道 / 首屏加载完成：无条件到底
  useEffect(() => {
    if (!initialLoading && !highlightId) scrollToBottom();
  }, [initialLoading, channel.id, scrollToBottom, highlightId]);

  // ?msg= 定位：滚到目标消息（居中）并高亮约 4 秒
  const [flashId, setFlashId] = useState<string | null>(null);
  useEffect(() => {
    if (!highlightId || initialLoading) return;
    const el = scrollRef.current?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(highlightId)}"]`);
    if (!el) return;
    stickRef.current = false;
    el.scrollIntoView({ block: "center" });
    setFlashId(highlightId);
    const t = setTimeout(() => setFlashId((f) => (f === highlightId ? null : f)), 4000);
    return () => clearTimeout(t);
  }, [highlightId, initialLoading, messages.length, scrollRef, stickRef]);

  function renderDecline(d: Message, standalone: boolean): ReactNode {
    const name = byId.get(d.sender.member_id)?.display_name || d.sender.display_name || "Bot";
    return (
      <div
        key={d.id}
        data-message-id={d.id}
        data-kind="bot_declined"
        className={`flex items-center gap-1.5 text-[13px] italic text-[#949ba4] ${standalone ? "mt-2 px-4 pl-[72px]" : "mt-0.5"} ${
          flashId === d.id ? "teams-flash" : ""
        }`}
      >
        <span aria-hidden="true" className="not-italic">
          {standalone ? "⊘" : "↳ ⊘"}
        </span>
        <span>
          <span className="font-medium not-italic text-[#b5bac1]">{name}</span> 选择不回复
          {d.content ? <span className="text-[#80848e]">：{d.content}</span> : null}
          {standalone && d.reply_to ? <span className="text-[#6d6f78]">（回复的是更早的消息）</span> : null}
        </span>
        <time className="ml-1 text-[11px] not-italic text-[#6d6f78]" dateTime={d.created_at}>
          {formatTime(d.created_at)}
        </time>
      </div>
    );
  }

  function renderGroup(rows: Row[]): ReactNode {
    const first = rows[0];
    if (first.declined) {
      const d = messages.find((m) => m.id === first.key);
      return d ? renderDecline(d, true) : null;
    }
    // 头像/名字优先用成员表（更新更及时），查不到再用消息里的 sender
    const sender = byId.get(first.sender.member_id) ?? first.sender;
    const name = sender.display_name || "未知成员";
    return (
      <div key={first.key} className="mt-4">
        {rows.map((row, i) => {
          const mentionsMe = !!myMemberId && row.mentionIds.includes(myMemberId);
          const ob = row.outbox;
          return (
            <div
              key={row.key}
              data-message-id={ob ? undefined : row.key}
              data-highlighted={flashId === row.key ? "true" : undefined}
              data-mentions-me={mentionsMe || undefined}
              className={`group/row relative flex gap-4 px-4 py-0.5 transition-colors ${flashId === row.key ? "teams-flash" : ""} ${
                mentionsMe
                  ? "bg-[#f0b232]/[0.08] hover:bg-[#f0b232]/[0.13] before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:bg-[#f0b232]"
                  : "hover:bg-[#2e3035]"
              } ${ob?.status === "sending" ? "opacity-60" : ""}`}
            >
              <div className="w-10 shrink-0 pt-0.5">
                {i === 0 ? (
                  <MemberAvatar member={sender} size={40} />
                ) : (
                  <time className="hidden pt-1 text-[10px] text-[#949ba4] group-hover/row:block" dateTime={row.created_at}>
                    {new Date(row.created_at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}
                  </time>
                )}
              </div>
              <div className="min-w-0 flex-1">
                {i === 0 ? (
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-[#f2f3f5]">{name}</span>
                    {first.sender.type === "bot" ? <BotBadge /> : null}
                    <time className="text-xs text-[#949ba4]" dateTime={first.created_at}>
                      {formatTime(first.created_at)}
                    </time>
                  </div>
                ) : null}
                {row.deleted ? <p className="text-sm italic text-[#949ba4]">（消息已删除）</p> : null}
                {!row.deleted && row.content ? (
                  <p className="whitespace-pre-wrap break-words py-0.5 text-[15px] leading-relaxed text-[#dbdee1]">
                    {parseContent(row.content, (id) => row.mentionNames.get(id) ?? byId.get(id)?.display_name).map((part, k) =>
                      part.type === "mention" ? (
                        <span
                          key={k}
                          className={`rounded px-0.5 font-medium ${
                            part.id === myMemberId ? "bg-[#f0b232]/30 text-[#f0b232]" : "bg-brand-soft text-brand-light"
                          }`}
                        >
                          @{part.name}
                        </span>
                      ) : (
                        <span key={k}>{part.text}</span>
                      ),
                    )}
                  </p>
                ) : null}
                {!row.deleted && row.attachments.length > 0 ? (
                  <div className="mt-1 flex flex-wrap gap-2 pb-0.5">
                    {row.attachments.map((a) => (
                      <AttachmentView
                        key={`${a.id}|${a.url}`}
                        attachment={a}
                        gone={!!goneAttachmentIds?.has(a.id)}
                        onPreview={setPreview}
                        onMediaLoad={stick}
                        onFirstError={() => onMediaError?.(a.id)}
                        onRetry={() => onMediaRetry?.(a.id)}
                      />
                    ))}
                  </div>
                ) : null}
                {ob ? (
                  ob.status === "sending" ? (
                    <p className="text-xs text-[#949ba4]">发送中…</p>
                  ) : (
                    <p className="flex flex-wrap items-center gap-2 text-xs text-[#f23f43]" role="alert">
                      <span aria-hidden="true">⚠</span>
                      <span>发送失败{ob.error ? `：${ob.error}` : ""}</span>
                      <button type="button" className="font-semibold text-brand-light hover:underline" onClick={() => onRetrySend?.(ob.local_id)}>
                        重发
                      </button>
                      <button type="button" className="font-semibold text-[#b5bac1] hover:underline" onClick={() => onDiscard?.(ob.local_id)}>
                        删除
                      </button>
                    </p>
                  )
                ) : null}
                {byTrigger.get(row.key)?.map((d) => renderDecline(d, false))}
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  const outboxRows: Row[] = outbox.map((o) => ({
    key: o.local_id,
    sender: o.sender,
    created_at: o.created_at,
    content: o.content,
    deleted: false,
    attachments: o.attachments,
    mentionIds: [],
    mentionNames: new Map(),
    outbox: o,
  }));

  return (
    <div
      ref={scrollRef}
      className="flex-1 overflow-y-auto pb-4 [overflow-anchor:none]"
      role="log"
      aria-live="polite"
      aria-busy={initialLoading}
      onScroll={(e) => {
        const el = e.currentTarget;
        trackScroll();
        prevHeightRef.current = el.scrollHeight;
        if (el.scrollTop < 120 && hasMore && !loadingOlder) onLoadOlder?.();
      }}
    >
      <div ref={contentRef}>
      {initialLoading ? (
        <MessageSkeleton />
      ) : hasMore ? (
        <div className="py-3 text-center text-xs text-[#949ba4]">
          {loadingOlder ? (
            "加载更早的消息…"
          ) : (
            <button type="button" className="hover:underline" onClick={() => onLoadOlder?.()}>
              加载更早的消息
            </button>
          )}
        </div>
      ) : (
        <WelcomeBlock channel={channel} />
      )}
      {!initialLoading ? groups.map((g) => renderGroup(g.map(toRow))) : null}
      {outboxRows.length ? renderGroup(outboxRows) : null}
      </div>

      {preview ? (
        <div
          role="dialog"
          aria-label="图片预览"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-8"
          onClick={() => setPreview(null)}
        >
          <img src={preview.url} alt={preview.file_name} className="max-h-full max-w-full rounded" />
        </div>
      ) : null}
    </div>
  );
}

/** 频道欢迎块：已加载到最早一条时显示在最上面；空频道也用它当空状态 */
function WelcomeBlock({ channel }: { channel: Channel }) {
  return (
    <div className="mx-4 mt-6 border-b border-white/5 pb-5" data-testid="channel-welcome">
      <div className="mb-3 flex h-16 w-16 items-center justify-center rounded-full bg-[#41434a] text-4xl text-white">#</div>
      <h2 className="text-3xl font-bold text-white">欢迎来到 #{channel.name}</h2>
      <p className="mt-2 text-[15px] text-[#b5bac1]">
        {channel.topic ? `${channel.topic} · ` : ""}这是 #{channel.name} 频道的开始。team 里的成员和 Bot 都可以在这里发言。
      </p>
    </div>
  );
}

function MessageSkeleton() {
  return (
    <div className="px-4 pt-6" aria-label="消息加载中">
      {[0.62, 0.4, 0.75, 0.5, 0.68, 0.35].map((w, i) => (
        <div key={i} className="mb-6 flex animate-pulse gap-4">
          <div className="h-10 w-10 shrink-0 rounded-full bg-[#3f4147]" />
          <div className="flex-1 space-y-2 pt-1">
            <div className="h-3 w-32 rounded bg-[#3f4147]" />
            <div className="h-3 rounded bg-[#383a40]" style={{ width: `${w * 100}%` }} />
            {i % 2 === 0 ? <div className="h-3 rounded bg-[#383a40]" style={{ width: `${w * 60}%` }} /> : null}
          </div>
        </div>
      ))}
    </div>
  );
}

/** 按附件宽高预留尺寸（最大 400×300），避免媒体加载后布局跳动 */
function mediaBox(a: Attachment): { width: number; height: number } {
  const w = a.width ?? (a.kind === "video" ? 400 : 320);
  const h = a.height ?? (a.kind === "video" ? 225 : 200);
  const k = Math.min(1, 400 / w, 300 / h);
  return { width: Math.round(w * k), height: Math.round(h * k) };
}

function AttachmentView({
  attachment: a,
  gone = false,
  onPreview,
  onMediaLoad,
  onFirstError,
  onRetry,
}: {
  attachment: Attachment;
  gone?: boolean;
  onPreview(a: Attachment): void;
  onMediaLoad(): void;
  onFirstError(): void;
  onRetry(): void;
}) {
  const [failed, setFailed] = useState(false);
  const [nonce, setNonce] = useState(0);
  const onError = () => {
    setFailed(true);
    onFirstError();
  };
  if (gone) {
    return (
      <div
        style={mediaBox(a)}
        className="flex min-h-[100px] min-w-[220px] flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-white/10 bg-[#2b2d31] text-sm text-[#949ba4]"
        role="group"
        aria-label={`${a.file_name} 已不可用`}
        data-testid="attachment-gone"
      >
        <span className="text-xl" aria-hidden="true">
          🚫
        </span>
        <span>附件已不可用</span>
        <span className="text-xs text-[#6d6f78]">所在消息或频道可能已被删除</span>
      </div>
    );
  }
  if (failed) {
    return (
      <div
        style={mediaBox(a)}
        className="flex min-h-[140px] min-w-[240px] flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-white/15 bg-[#2b2d31] text-sm text-[#949ba4]"
        role="group"
        aria-label={`${a.file_name} 加载失败`}
      >
        <span className="text-2xl" aria-hidden="true">
          {a.kind === "image" ? "🖼" : "🎞"}
        </span>
        <span>{a.kind === "image" ? "图片" : "视频"}加载失败</span>
        <button
          type="button"
          className="rounded bg-brand px-3 py-1 text-xs font-semibold text-white hover:bg-brand-hover"
          onClick={() => {
            setFailed(false);
            setNonce((n) => n + 1);
            onRetry();
          }}
        >
          重试
        </button>
      </div>
    );
  }
  if (a.kind === "image") {
    return (
      <button type="button" onClick={() => onPreview(a)} className="overflow-hidden rounded-lg" title="点击预览">
        <img key={nonce} src={a.url} alt={a.file_name} onLoad={onMediaLoad} onError={onError} style={mediaBox(a)} className="object-cover" />
      </button>
    );
  }
  return (
    <video
      key={nonce}
      src={a.url}
      controls
      preload="metadata"
      title={a.file_name}
      onLoadedMetadata={onMediaLoad}
      onError={onError}
      style={mediaBox(a)}
      className="rounded-lg bg-black"
    />
  );
}
