import { errorText } from "../lib/errorText";
import { Button, CloseButton, ProgressBar, TextArea } from "@heroui/react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { Attachment, Member } from "../api/types";
import type { UploadOptions } from "../api/client";
import {
  filterCandidates,
  getMentionQuery,
  insertMention,
  mentionKeyAction,
  serializeMentions,
  type MentionCandidate,
} from "../lib/mention";
import { ACCEPT_ATTR, checkUpload } from "../lib/upload";
import { BotBadge, MemberAvatar } from "./MemberAvatar";

export interface ComposerSendPayload {
  /** 线上格式正文：提及已转成 `<@member_id>`（docs/api.md §4.2） */
  content: string;
  attachments: Attachment[];
  /** 被 @ 的 member_id */
  mentionIds: string[];
  /** 附件 id → 本地文件的 object URL：消息“发送中”时先显示本地预览（所有权交给外层，由外层释放） */
  previews?: Record<string, string>;
}

interface PendingUpload {
  key: string;
  name: string;
  progress: number;
  controller: AbortController;
}

/** 底部输入框：附件（上传进度 + 取消，卡片在输入框内部占位，不浮在消息上）、@ 补全弹层（键盘导航、无匹配提示） */
export function Composer({
  channelName,
  members,
  onUpload,
  onSend,
  autoFocus = false,
  onAutoFocused,
}: {
  channelName: string;
  /** 挂载时把焦点放进输入框（例如当前频道被删、跳回默认频道后） */
  autoFocus?: boolean;
  onAutoFocused?(): void;
  members: Member[];
  onUpload(file: File, opts: UploadOptions): Promise<Attachment>;
  /** 发送交给外层（乐观显示 + 失败重发），这里调用后立即清空输入 */
  onSend(payload: ComposerSendPayload): void;
}) {
  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [picked, setPicked] = useState<MentionCandidate[]>([]);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  // 附件 id → 本地预览 object URL；发送时交给外层，移除附件 / 卸载时释放
  const previewsRef = useRef<Record<string, string>>({});
  useEffect(() => () => Object.values(previewsRef.current).forEach((u) => URL.revokeObjectURL(u)), []);
  const [uploads, setUploads] = useState<PendingUpload[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [activeIdx, setActiveIdx] = useState(0);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!autoFocus) return;
    textareaRef.current?.focus();
    onAutoFocused?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoFocus]);

  const candidates = useMemo<(MentionCandidate & { member: Member })[]>(
    () => members.map((m) => ({ id: m.id, name: m.display_name, kind: m.type, member: m })),
    [members],
  );
  const mq = getMentionQuery(text, caret);
  const popupOpen = !!mq && mq.start !== dismissedAt;
  const suggestions = popupOpen ? filterCandidates(candidates, mq.query) : [];
  const safeIdx = Math.min(activeIdx, Math.max(0, suggestions.length - 1));
  const uploading = uploads.length > 0;

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

  function send() {
    if (uploading) {
      setError("附件还在上传，请稍候或取消上传");
      return;
    }
    if (!text.trim() && attachments.length === 0) return;
    setError(null);
    const { content, mentionIds } = serializeMentions(text.trim(), picked);
    const previews: Record<string, string> = {};
    for (const a of attachments) {
      const u = previewsRef.current[a.id];
      if (u) {
        previews[a.id] = u;
        delete previewsRef.current[a.id];
      }
    }
    onSend({ content, attachments, mentionIds, previews });
    setText("");
    setCaret(0);
    setPicked([]);
    setAttachments([]);
  }

  async function uploadOne(file: File) {
    // 前置校验（docs/api.md §5）：图片 jpeg/png/gif/webp ≤10MB，视频 mp4/webm/mov ≤100MB
    const check = checkUpload(file);
    if (!check.ok) {
      setError(check.reason);
      return;
    }
    const key = crypto.randomUUID();
    const controller = new AbortController();
    setUploads((prev) => [...prev, { key, name: file.name, progress: 0, controller }]);
    try {
      const a = await onUpload(file, {
        signal: controller.signal,
        onProgress: (p) => setUploads((prev) => prev.map((u) => (u.key === key ? { ...u, progress: p } : u))),
      });
      if (typeof URL.createObjectURL === "function") previewsRef.current[a.id] = URL.createObjectURL(file);
      setAttachments((prev) => [...prev, a]);
    } catch (e) {
      if (!(e instanceof DOMException && e.name === "AbortError")) setError(errorText(e));
    } finally {
      setUploads((prev) => prev.filter((u) => u.key !== key));
    }
  }

  function onFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setError(null);
    for (const f of Array.from(files)) void uploadOne(f);
    if (fileRef.current) fileRef.current.value = "";
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (popupOpen) {
      const act = mentionKeyAction(e.key, suggestions.length, safeIdx);
      if (act) {
        e.preventDefault();
        if (act.type === "move") setActiveIdx(act.index);
        else if (act.type === "pick") pick(suggestions[act.index]);
        else setDismissedAt(mq?.start ?? null);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  }

  const hasTray = attachments.length > 0 || uploads.length > 0;

  return (
    <div className="relative px-4 pb-6">
      {popupOpen ? (
        <div
          role="listbox"
          aria-label="@ 成员候选"
          className="absolute bottom-full left-4 right-4 z-10 mb-2 overflow-hidden rounded-lg bg-[#2b2d31] py-2 shadow-xl ring-1 ring-black/40"
        >
          <div className="flex items-center justify-between px-3 pb-1 text-xs font-semibold uppercase tracking-wide text-[#949ba4]">
            <span>成员与 Bot{mq?.query ? ` · 匹配“${mq.query}”` : ""}</span>
            <span className="font-normal normal-case">↑↓ 选择 · Enter/Tab 确认 · Esc 关闭</span>
          </div>
          {suggestions.length === 0 ? (
            <div className="px-3 py-2 text-sm text-[#949ba4]">没有匹配的成员</div>
          ) : (
            suggestions.map((c, i) => (
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
                <span className="text-xs text-[#949ba4]">@{c.member.username}</span>
                {c.kind === "bot" ? <BotBadge /> : null}
              </button>
            ))
          )}
        </div>
      ) : null}

      {hasTray ? (
        <div className="flex flex-wrap gap-2 rounded-t-lg bg-[#383a40] p-3">
          {attachments.map((a) => (
            <div key={a.id} className="relative rounded bg-[#2b2d31] p-1">
              {a.kind === "image" ? (
                <img src={previewsRef.current[a.id] ?? a.url} alt={a.file_name} className="h-20 w-20 rounded object-cover" />
              ) : (
                <video src={previewsRef.current[a.id] ?? a.url} className="h-20 w-28 rounded bg-black object-cover" muted />
              )}
              <CloseButton
                aria-label={`移除 ${a.file_name}`}
                onPress={() => {
                  const u = previewsRef.current[a.id];
                  if (u) URL.revokeObjectURL(u);
                  delete previewsRef.current[a.id];
                  setAttachments((prev) => prev.filter((x) => x.id !== a.id));
                }}
                className="absolute -top-2 -right-2 size-5 min-w-5 rounded-full bg-[#f23f43] text-white hover:bg-[#d83c3e] data-[hovered=true]:bg-[#d83c3e] [&_svg]:size-3"
              />
            </div>
          ))}
          {uploads.map((u) => (
            <div key={u.key} className="flex h-[88px] w-44 flex-col justify-between rounded bg-[#2b2d31] p-2" aria-label={`${u.name} 上传中`}>
              <div className="truncate text-xs text-[#dbdee1]" title={u.name}>
                {u.name}
              </div>
              <div>
                <div className="mb-1 flex justify-between text-[11px] text-[#949ba4]">
                  <span>上传中 {Math.round(u.progress * 100)}%</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-auto min-h-0 min-w-0 rounded-none bg-transparent p-0 text-[11px] font-normal text-[#f23f43] hover:bg-transparent hover:underline data-[hovered=true]:bg-transparent data-[pressed=true]:scale-100"
                    onPress={() => u.controller.abort()}
                  >
                    取消
                  </Button>
                </div>
                <ProgressBar aria-label={`${u.name} 上传进度`} value={Math.round(u.progress * 100)} className="gap-0 [--progress-bar-fill:var(--color-brand)]">
                  <ProgressBar.Track className="h-1.5 rounded bg-[#1e1f22]">
                    <ProgressBar.Fill className="rounded-none" />
                  </ProgressBar.Track>
                </ProgressBar>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      <div className={`flex items-end gap-2 bg-[#383a40] px-3 py-2 ${hasTray ? "rounded-b-lg" : "rounded-lg"}`}>
        <Button
          isIconOnly
          aria-label="上传图片或视频"
          onPress={() => fileRef.current?.click()}
          className="mb-0.5 size-6 min-w-6 shrink-0 rounded-full bg-[#b5bac1] text-lg leading-none font-bold text-[#383a40] hover:bg-white data-[hovered=true]:bg-white"
        >
          +
        </Button>
        <input ref={fileRef} type="file" accept={ACCEPT_ATTR} multiple hidden onChange={(e) => onFiles(e.target.files)} />
        <TextArea
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
          className="max-h-48 min-h-[24px] flex-1 resize-none rounded-none border-0 bg-transparent px-0 py-0.5 text-[15px] text-[#dbdee1] shadow-none outline-none placeholder:text-[#6d6f78] hover:bg-transparent focus:bg-transparent focus:shadow-none focus:ring-0 focus:outline-none data-[focused=true]:bg-transparent data-[focused=true]:shadow-none data-[hovered=true]:bg-transparent sm:text-[15px]"
        />
      </div>
      {error ? (
        <p className="mt-1 text-xs text-[#f23f43]" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
