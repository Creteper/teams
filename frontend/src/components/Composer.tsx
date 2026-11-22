import { createPortal } from "react-dom";
import type { EditorView } from "@codemirror/view";
import { insertNewlineAndIndent } from "@codemirror/commands";
import { IssueIcon } from "./issues/IssueIcon";
import { inMarkdownCode } from "./liveMarkdown";
import { LiveMarkdownInput } from "./LiveMarkdownInput";
import { CreateQACard } from "./QACard";
import { errorText } from "../lib/errorText";
import { Button, CloseButton, Modal, ProgressBar } from "@heroui/react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Attachment, Member, NewQACard } from "../api/types";
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
  onSendCard,
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
  onSendCard?(card: NewQACard, clientId: string): Promise<void>;
  onSend(payload: ComposerSendPayload): void;
}) {
  const [cardOpen,setCardOpen]=useState(false);
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
  const editorRef = useRef<EditorView>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflow, setOverflow] = useState(false);
  // Move the same editing surface so selection, undo and IME state survive resizing.
  const [surface] = useState(() => document.createElement("div"));
  const attachSurface = useCallback((slot: HTMLDivElement | null) => {
    if (slot) {
      slot.appendChild(surface);
      editorRef.current?.requestMeasure();
    }
  }, [surface]);
  const wasExpanded = useRef(false);
  useLayoutEffect(() => {
    if (!expanded && !wasExpanded.current) return;
    wasExpanded.current = expanded;
    const frame = requestAnimationFrame(() => editorRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [expanded]);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!autoFocus) return;
    editorRef.current?.focus();
    onAutoFocused?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoFocus]);

  const candidates = useMemo<(MentionCandidate & { member: Member })[]>(
    () => members.map((m) => ({ id: m.id, name: m.display_name, kind: m.type, member: m })),
    [members],
  );
  const mq = getMentionQuery(text, caret);
  const popupOpen = !!mq && mq.start !== dismissedAt &&
    !(editorRef.current && inMarkdownCode(editorRef.current.state, caret));
  const suggestions = popupOpen ? filterCandidates(candidates, mq.query) : [];
  const safeIdx = Math.min(activeIdx, Math.max(0, suggestions.length - 1));
  const uploading = uploads.length > 0;

  function pick(c: MentionCandidate) {
    if (!mq) return;
    const next = insertMention(text, mq.start, caret, c.name);
    const editor = editorRef.current;
    if (!editor) return;
    editor.dispatch({ changes: { from: mq.start, to: caret, insert: next.text.slice(mq.start, next.caret) },
      selection: { anchor: next.caret }, userEvent: "input.complete" });
    setPicked(p => p.some(x => x.id === c.id) ? p : [...p, { id: c.id, name: c.name, kind: c.kind }]);
    setActiveIdx(0);
    editor.focus();
  }

  function send() {
    if (uploading) {
      setError("附件还在上传，请稍候或取消上传");
      return;
    }
    if (!text.trim() && attachments.length === 0) return;
    setError(null);
    const state = editorRef.current?.state;
    const { content, mentionIds } = serializeMentions(text.trim() ? text : "", picked,
      offset => !state || !inMarkdownCode(state, offset + 1));
    const previews: Record<string, string> = {};
    for (const a of attachments) {
      const u = previewsRef.current[a.id];
      if (u) {
        previews[a.id] = u;
        delete previewsRef.current[a.id];
      }
    }
    onSend({ content, attachments, mentionIds, previews });
    setExpanded(false);
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

  function onKeyDown(e: KeyboardEvent, view: EditorView) {
    if (popupOpen && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      const act = mentionKeyAction(e.key, suggestions.length, safeIdx);
      if (act) {
        if (act.type === "move") setActiveIdx(act.index);
        else if (act.type === "pick") pick(suggestions[act.index]);
        else setDismissedAt(mq?.start ?? null);
        e.stopPropagation();
        return true;
      }
    }
    if (e.key !== "Enter") return false;
    if (!e.shiftKey && !e.ctrlKey && !e.metaKey && inMarkdownCode(view.state, view.state.selection.main.head, true)) {
      return insertNewlineAndIndent(view);
    }
    if (e.shiftKey || (expanded && !e.ctrlKey && !e.metaKey)) {
      view.dispatch(view.state.replaceSelection("\n"), { scrollIntoView: true, userEvent: "input.type" });
    } else {
      send();
    }
    return true;
  }

  const hasTray = attachments.length > 0 || uploads.length > 0;
  const suggestionsMenu = popupOpen && (
    <div role="listbox" aria-label="@ 成员候选"
      className="absolute bottom-full inset-x-0 z-10 mb-2 max-h-64 overflow-y-auto rounded-lg bg-[#2b2d31] py-2 shadow-xl ring-1 ring-black/40">
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
  );

  const tray = hasTray && (
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
  );

  const uploadButton = (
    <Button isIconOnly size="sm" variant="ghost" aria-label="上传图片或视频"
      onPress={() => fileRef.current?.click()}
      className="size-8 min-w-8 shrink-0 rounded-md p-0 text-[#b5bac1] hover:text-white">
      <span className="grid size-6 place-items-center rounded-full bg-current">
        <span className="text-[#383a40]"><IssueIcon name="plus" size={18} /></span>
      </span>
    </Button>
  );
  const alert = error && <p className="mt-1 text-xs text-[#f23f43]" role="alert">{error}</p>;
  const editor = createPortal(
    <LiveMarkdownInput editorRef={editorRef} label="消息输入框" hint={`给 #${channelName} 发消息（支持 Markdown 和 @ 提及）`}
      value={text} onChange={value => { setText(value); setActiveIdx(0); setDismissedAt(null); }}
      onCaret={setCaret} onKeyDown={onKeyDown} onOverflowChange={setOverflow} />,
    surface,
  );

  return (
    <div className="relative px-4 pb-6">
      {editor}
      <input ref={fileRef} type="file" accept={ACCEPT_ATTR} multiple hidden onChange={e => onFiles(e.target.files)} />
      {cardOpen && onSendCard && <CreateQACard members={members} onSend={onSendCard} onClose={() => setCardOpen(false)} />}
      {expanded ? (
        <Modal.Backdrop isOpen onOpenChange={open => { if (!open) setExpanded(false); }} className="z-40 bg-black/70">
          <Modal.Container placement="center" className="w-full p-3 sm:p-6">
            <Modal.Dialog aria-label="编写消息" className="issue-dialog issue-maximized gap-3">
              <Modal.Header className="flex shrink-0 flex-row items-center justify-between p-0">
                <Modal.Heading className="truncate text-sm font-semibold">给 #{channelName} 发消息</Modal.Heading>
                <Button isIconOnly size="sm" variant="ghost" aria-label="收起编辑器" onPress={() => setExpanded(false)}>
                  <IssueIcon name="shrink" />
                </Button>
              </Modal.Header>
              <div ref={attachSurface} className="chat-expanded-input" />
              {tray}
              {alert}
              <Modal.Footer className="relative items-center gap-2 border-t border-white/10 pt-3">
                {suggestionsMenu}
                {uploadButton}
                <span className="mr-auto text-xs text-[#b5bac1]">Ctrl / ⌘ + Enter 发送</span>
                <Button variant="primary" isDisabled={uploading || (!text.trim() && !attachments.length)} onPress={send}>发送消息</Button>
              </Modal.Footer>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      ) : (
        <>
          {suggestionsMenu}
          {tray}
          <div className={`flex items-start gap-2 bg-[#383a40] px-2 py-2 ${hasTray ? "rounded-b-lg" : "rounded-lg"}`}>
            {uploadButton}
            {onSendCard && <Button size="sm" variant="ghost" className="h-8 min-h-8 shrink-0 px-2"
              aria-label="发送 QA 卡片" onPress={() => setCardOpen(true)}>QA 卡片</Button>}
            <div ref={attachSurface} className="chat-input" />
            <div className="w-7 shrink-0">
              {overflow && <Button size="sm" variant="ghost" isIconOnly aria-label="展开编辑器" className="h-8 min-w-7 w-7"
                onPress={() => setExpanded(true)}><IssueIcon name="expand" size={16} /></Button>}
            </div>
          </div>
          {alert}
        </>
      )}
    </div>
  );
}
