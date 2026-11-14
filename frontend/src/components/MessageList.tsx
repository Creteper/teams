import { useEffect, useMemo, useRef, useState } from "react";
import type { Attachment, Member, Message } from "../api/types";
import { parseContent } from "../lib/mention";
import { formatTime, groupMessages } from "../lib/messages";
import { BotBadge, MemberAvatar } from "./MemberAvatar";

/** 消息流：头像 + 名字 + 时间，连续消息合并；支持图片预览和视频播放 */
export function MessageList({ messages, members, myMemberId }: { messages: Message[]; members: Member[]; myMemberId: string }) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // 用户停留在底部时，新消息/媒体加载后保持贴底
  const stickRef = useRef(true);
  const stick = () => {
    if (stickRef.current) bottomRef.current?.scrollIntoView({ block: "end" });
  };
  const [preview, setPreview] = useState<Attachment | null>(null);
  const byId = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);
  const groups = useMemo(() => groupMessages(messages), [messages]);

  useEffect(() => {
    stick();
  }, [messages.length]);

  return (
    <div
      ref={scrollRef}
      className="flex-1 overflow-y-auto py-4"
      role="log"
      aria-live="polite"
      onScroll={(e) => {
        const el = e.currentTarget;
        stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
    >
      {groups.length === 0 ? (
        <p className="px-4 text-sm text-[#949ba4]">还没有消息，发第一条吧。</p>
      ) : null}
      {groups.map((group) => {
        const first = group[0];
        // 头像/名字优先用成员表（含 avatar_shape 等最新字段），查不到（如已删除 bot）回退到消息里的 sender
        const sender = byId.get(first.sender.member_id) ?? first.sender;
        const name = sender.display_name || "未知成员";
        return (
          <div key={first.id} className="group/msg mt-4 flex gap-4 px-4 py-0.5 hover:bg-[#2e3035]">
            <div className="pt-0.5">
              <MemberAvatar member={sender} size={40} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="font-medium text-[#f2f3f5]">{name}</span>
                {first.sender.type === "bot" ? <BotBadge /> : null}
                <time className="text-xs text-[#949ba4]" dateTime={first.created_at}>
                  {formatTime(first.created_at)}
                </time>
              </div>
              {group.map((msg) => (
                <div key={msg.id} className="py-0.5">
                  {msg.deleted ? (
                    <p className="text-sm italic text-[#949ba4]">（消息已删除）</p>
                  ) : null}
                  {!msg.deleted && msg.content ? (
                    <p className="whitespace-pre-wrap break-words text-[15px] leading-relaxed text-[#dbdee1]">
                      {parseContent(
                        msg.content,
                        (id) => msg.mentions.find((x) => x.member_id === id)?.display_name ?? byId.get(id)?.display_name,
                      ).map((part, i) =>
                        part.type === "mention" ? (
                          <span
                            key={i}
                            className={`rounded px-0.5 font-medium ${
                              part.id === myMemberId ? "bg-[#f0b232]/30 text-[#f0b232]" : "bg-[#5865f2]/30 text-[#c9cdfb]"
                            }`}
                          >
                            @{part.name}
                          </span>
                        ) : (
                          <span key={i}>{part.text}</span>
                        ),
                      )}
                    </p>
                  ) : null}
                  {!msg.deleted && msg.attachments.length > 0 ? (
                    <div className="mt-1 flex flex-wrap gap-2">
                      {msg.attachments.map((a) => (
                        <AttachmentView key={a.id} attachment={a} onPreview={setPreview} onMediaLoad={stick} />
                      ))}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        );
      })}
      <div ref={bottomRef} />

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

function AttachmentView({
  attachment: a,
  onPreview,
  onMediaLoad,
}: {
  attachment: Attachment;
  onPreview(a: Attachment): void;
  onMediaLoad(): void;
}) {
  if (a.kind === "image") {
    return (
      <button type="button" onClick={() => onPreview(a)} className="overflow-hidden rounded-lg" title="点击预览">
        <img src={a.url} alt={a.file_name} onLoad={onMediaLoad} className="max-h-[300px] max-w-[400px] object-cover" />
      </button>
    );
  }
  return (
    <video
      src={a.url}
      controls
      preload="metadata"
      title={a.file_name}
      onLoadedMetadata={onMediaLoad}
      className="max-h-[300px] max-w-[400px] rounded-lg bg-black"
    />
  );
}
