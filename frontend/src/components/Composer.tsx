import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { Attachment, Member } from "../api/types";
import { filterCandidates, getMentionQuery, insertMention, serializeMentions, type MentionCandidate } from "../lib/mention";
import { ACCEPT_ATTR, checkUpload } from "../lib/upload";
import { BotBadge, MemberAvatar } from "./MemberAvatar";

export interface ComposerSendPayload {
  /** 线上格式正文：提及已转成 `<@member_id>`（docs/api.md §4.2） */
  content: string;
  attachments: Attachment[];
  /** 被 @ 的 member_id（服务端会自行解析，这里仅供前端使用） */
  mentionIds: string[];
}

/** 底部输入框：附件按钮（图片/视频）、@ 补全弹层（用户和 bot 都可选） */
export function Composer({
  channelName,
  members,
  onUpload,
  onSend,
}: {
  channelName: string;
  members: Member[];
  onUpload(file: File): Promise<Attachment>;
  onSend(payload: ComposerSendPayload): Promise<void>;
}) {
  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [picked, setPicked] = useState<MentionCandidate[]>([]);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeIdx, setActiveIdx] = useState(0);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const candidates = useMemo<(MentionCandidate & { member: Member })[]>(
    () => members.map((m) => ({ id: m.id, name: m.display_name, kind: m.type, member: m })),
    [members],
  );
  const mq = getMentionQuery(text, caret);
  const suggestions = mq && mq.start !== dismissedAt ? filterCandidates(candidates, mq.query) : [];
  const open = suggestions.length > 0;
  const safeIdx = Math.min(activeIdx, Math.max(0, suggestions.length - 1));

  function pick(c: MentionCandidate) {
    if (!mq) return;
    const next = insertMention(text, mq.start, caret, c.name);
    setText(next.text);
    setCaret(next.caret);
    setPicked((p) => (p.some((x) => x.id === c.id) ? p : [...p, { id: c.id, name: c.name, kind: c.kind }]));
    setActiveIdx(0);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(next.caret, next.caret);
      }
    });
  }

  async function send() {
    if (sending || uploading) return;
    if (!text.trim() && attachments.length === 0) return;
    setSending(true);
    setError(null);
    try {
      const { content, mentionIds } = serializeMentions(text.trim(), picked);
      await onSend({ content, attachments, mentionIds });
      setText("");
      setCaret(0);
      setPicked([]);
      setAttachments([]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  }

  async function onFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setUploading(true);
    setError(null);
    try {
      for (const file of Array.from(files)) {
        // 前置校验（docs/api.md §5）：图片 jpeg/png/gif/webp ≤10MB，视频 mp4/webm/mov ≤100MB
        const check = checkUpload(file);
        if (!check.ok) throw new Error(check.reason);
        const a = await onUpload(file);
        setAttachments((prev) => [...prev, a]);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (open) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIdx((safeIdx + 1) % suggestions.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIdx((safeIdx - 1 + suggestions.length) % suggestions.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        pick(suggestions[safeIdx]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setDismissedAt(mq?.start ?? null);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  }

  return (
    <div className="relative px-4 pb-6">
      {open ? (
        <div
          role="listbox"
          aria-label="@ 成员候选"
          className="absolute bottom-full left-4 right-4 mb-2 overflow-hidden rounded-lg bg-[#2b2d31] py-2 shadow-xl ring-1 ring-black/40"
        >
          <div className="px-3 pb-1 text-xs font-semibold uppercase tracking-wide text-[#949ba4]">成员与 Bot</div>
          {suggestions.map((c, i) => (
            <button
              key={c.id}
              type="button"
              role="option"
              aria-selected={i === safeIdx}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(c);
              }}
              onMouseEnter={() => setActiveIdx(i)}
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm ${
                i === safeIdx ? "bg-[#404249] text-white" : "text-[#dbdee1]"
              }`}
            >
              <MemberAvatar member={c.member} size={24} />
              <span>{c.name}</span>
              {c.kind === "bot" ? <BotBadge /> : null}
            </button>
          ))}
        </div>
      ) : null}

      {attachments.length > 0 ? (
        <div className="flex flex-wrap gap-2 rounded-t-lg bg-[#383a40] p-3">
          {attachments.map((a) => (
            <div key={a.id} className="relative rounded bg-[#2b2d31] p-1">
              {a.kind === "image" ? (
                <img src={a.url} alt={a.file_name} className="h-20 w-20 rounded object-cover" />
              ) : (
                <video src={a.url} className="h-20 w-28 rounded bg-black object-cover" muted />
              )}
              <button
                type="button"
                aria-label={`移除 ${a.file_name}`}
                onClick={() => setAttachments((prev) => prev.filter((x) => x.id !== a.id))}
                className="absolute -right-2 -top-2 h-5 w-5 rounded-full bg-[#f23f43] text-xs text-white"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      ) : null}

      <div className={`flex items-end gap-2 bg-[#383a40] px-3 py-2 ${attachments.length ? "rounded-b-lg" : "rounded-lg"}`}>
        <button
          type="button"
          aria-label="上传图片或视频"
          title="上传图片或视频"
          disabled={uploading}
          onClick={() => fileRef.current?.click()}
          className="mb-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#b5bac1] text-lg font-bold leading-none text-[#383a40] hover:bg-white disabled:opacity-50"
        >
          +
        </button>
        <input
          ref={fileRef}
          type="file"
          accept={ACCEPT_ATTR}
          multiple
          hidden
          onChange={(e) => void onFiles(e.target.files)}
        />
        <textarea
          ref={textareaRef}
          rows={1}
          value={text}
          placeholder={`给 #${channelName} 发消息（输入 @ 提及成员或 Bot）`}
          aria-label="消息输入框"
          onChange={(e) => {
            setText(e.target.value);
            setCaret(e.target.selectionStart ?? e.target.value.length);
            setActiveIdx(0);
            setDismissedAt(null);
          }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
          onKeyDown={onKeyDown}
          className="max-h-48 min-h-[24px] flex-1 resize-none bg-transparent py-0.5 text-[15px] text-[#dbdee1] placeholder:text-[#6d6f78] focus:outline-none"
        />
        {uploading ? <span className="text-xs text-[#949ba4]">上传中…</span> : null}
      </div>
      {error ? <p className="mt-1 text-xs text-[#f23f43]">{error}</p> : null}
    </div>
  );
}
