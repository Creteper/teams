import { useEffect, useRef, useState } from "react";
import type { User } from "../../api/types";
import { MemberAvatar } from "../MemberAvatar";
import { api } from "../../api";
import { priorityNames, type Issue, type IssueComment } from "../../api/issues";
import { errorText } from "../../lib/errorText";
import { IssueIcon } from "./IssueIcon";
import { Dot } from "./IssueOptions";
import { MarkdownBody, MarkdownEditor, MarkdownTitle } from "./MarkdownEditor";

import type { EditorView } from "@codemirror/view";
import { LiveMarkdownInput } from "../LiveMarkdownInput";
import { FileLinks } from "./FileLinks";

type DiscussionProps = { issue: Issue; token: string; me: User };

function CommentTime({ value, now }: { value: string; now: number }) {
  const date = new Date(value);
  const minutes = Math.max(0, Math.floor((now - date.getTime()) / 60000));
  let label = "刚刚";
  if (minutes >= 10080) label = Math.floor(minutes / 10080) + " 周前";
  else if (minutes >= 1440) label = Math.floor(minutes / 1440) + " 天前";
  else if (minutes >= 60) label = Math.floor(minutes / 60) + " 小时前";
  else if (minutes > 0) label = minutes + " 分钟前";
  return <time dateTime={value} title={date.toLocaleString()}>{label}</time>;
}

function CommentComposer({ issue, token, me, replyTo, editor, onSent, cancelTarget }: DiscussionProps & {
  replyTo?: IssueComment; editor?: React.RefObject<EditorView | null>;
  onSent(c: IssueComment): void; cancelTarget?: () => void;
}) {
  const [body, setBody] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const uploadIds = useRef(new Map<File, string>());
  const requestId = useRef("");
  const input = useRef<HTMLInputElement>(null);
  const sendLabel = replyTo ? "发送回复" : "发送评论";

  async function send() {
    if (busy || (!body.trim() && !files.length)) return;
    setError(""); setBusy(true);
    try {
      if (!requestId.current) requestId.current = crypto.randomUUID();
      const ids: string[] = [];
      for (const file of files) {
        if (!uploadIds.current.has(file)) {
          const uploaded = await api.uploadIssueAttachment(token, issue.team_id, file);
          uploadIds.current.set(file, uploaded.id);
        }
        ids.push(uploadIds.current.get(file)!);
      }
      const comment = await api.createIssueComment(token, issue.team_id, issue.id, {
        id: requestId.current, body, attachment_ids: ids, reply_to_id: replyTo?.id ?? null,
      });
      setBody(""); setFiles([]); uploadIds.current.clear(); requestId.current = "";
      onSent(comment);
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  }
  return <fieldset disabled={busy} className={`issue-comment-form ${replyTo ? "inline-reply" : "new-comment"}`}>
    {cancelTarget && <div className="comment-target">回复 {replyTo?.author_name}<button aria-label="取消指定回复" onClick={cancelTarget}>×</button></div>}
    <div className="comment-input-row">
      {replyTo && <MemberAvatar member={me} size={20} />}
      <LiveMarkdownInput editorRef={editor} className="issue-comment-input" label={replyTo ? "回复内容" : "评论内容"}
        hint={replyTo ? "写下回复…" : "写下评论…"} maxLength={32000} disabled={busy} value={body} onChange={setBody}
        onKeyDown={e => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { void send(); return true; }
          return false;
        }} />
      <div className="comment-actions">
        <input hidden type="file" multiple ref={input} onChange={e => {
          const chosen = Array.from(e.target.files ?? []); setFiles(f => [...f, ...chosen]); e.target.value = "";
        }} />
        <button className="issue-icon-button" aria-label={replyTo ? "添加回复附件" : "添加评论附件"} title="添加附件" onClick={() => input.current?.click()}><IssueIcon name="attach" size={16} /></button>
        <button className="issue-icon-button comment-send" aria-label={sendLabel} title={sendLabel} disabled={busy || (!body.trim() && !files.length)} onClick={() => void send()}>
          <IssueIcon name="send" size={16} />
        </button>
      </div>
    </div>
    {files.length > 0 && <div className="issue-file-list">{files.map((file, i) => <span className="issue-tag" key={i}>{file.name}
      <button aria-label={"移除 " + file.name} onClick={() => setFiles(f => f.filter((_, n) => n !== i))}>×</button></span>)}</div>}
    {error && <p role="alert" className="issue-error">{error}</p>}
  </fieldset>;
}

function CommentThread({ root, replies, byId, now, onSent, ...props }: DiscussionProps & {
  root: IssueComment; replies: IssueComment[]; byId: Map<string, IssueComment>; now: number; onSent(c: IssueComment): void;
}) {
  const [target, setTarget] = useState<IssueComment | null>(null);
  const editor = useRef<EditorView>(null);
  function entry(c: IssueComment) {
    const parent = c.reply_to_id ? byId.get(c.reply_to_id) : undefined;
    return <article key={c.id} aria-label={c.author_name + "的评论"} className="issue-comment">
      <header><MemberAvatar member={{ display_name: c.author_name, avatar_url: c.author_avatar_url }} size={20} />
        <strong>{c.author_name}</strong><CommentTime value={c.created_at} now={now} />
        {!props.issue.archived_at && <button className="issue-reply" onClick={() => { setTarget(c.id === root.id ? null : c); editor.current?.focus(); }}>回复</button>}
      </header>
      <div className="comment-content">
        {parent && parent.id !== root.id && <span className="comment-target">回复 {parent.author_name}</span>}
        {c.body && <MarkdownBody text={c.body} />}
        <FileLinks token={props.token} files={c.attachments} />
      </div>
    </article>;
  }
  return <div className="issue-thread">
    {entry(root)}
    {replies.length > 0 && <div className="issue-replies">{replies.map(entry)}</div>}
    {!props.issue.archived_at && <CommentComposer {...props} editor={editor} replyTo={target ?? root} cancelTarget={target ? () => setTarget(null) : undefined}
      onSent={comment => { setTarget(null); onSent(comment); }} />}
  </div>;
}

function Discussion({ issue, token, me }: DiscussionProps) {
  const [comments, setComments] = useState<IssueComment[]>([]);
  const [loadError, setLoadError] = useState("");
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    let active = true;
    setLoadError("");
    api.listIssueComments(token, issue.team_id, issue.id).then(page => {
      if (active) setComments(page.items);
    }).catch(e => { if (active) setLoadError(errorText(e)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [token, issue.team_id, issue.id, revision]);
  function onSent(comment: IssueComment) {
    setComments(items => items.some(c => c.id === comment.id) ? items : [...items, comment]);
    setRevision(v => v + 1);
  }
  const byId = new Map(comments.map(c => [c.id, c]));
  const replies = new Map<string, IssueComment[]>();
  for (const c of comments) {
    if (!c.root_id) continue;
    const siblings = replies.get(c.root_id);
    if (siblings) siblings.push(c); else replies.set(c.root_id, [c]);
  }
  return <section className="issue-discussion">
    <h2>评论</h2>
    <div className="issue-created-event">
      <MemberAvatar member={{ display_name: issue.creator_name, avatar_url: issue.creator_avatar_url }} size={16} />
      <span>{issue.creator_name} 创建了此 Issue</span> · <CommentTime value={issue.created_at} now={now} />
    </div>
    {loading && <p>正在加载评论…</p>}
    {loadError && <p role="alert" className="issue-error">{loadError} <button onClick={() => setRevision(v => v + 1)}>重试</button></p>}
    {comments.filter(c => !c.root_id).map(root => <CommentThread key={root.id} root={root} replies={replies.get(root.id) ?? []}
      {...{ issue, token, me, now, byId, onSent }} />)}
    {!issue.archived_at && <CommentComposer {...{ issue, token, me, onSent }} />}
  </section>;
}
export function IssueDetail({ issue, token, me, close, update, onArchived }: {
  issue: Issue; me: User; token: string; close(): void; update(issue: Issue): void; onArchived(): void;
}) {
  const [editing, setEditing] = useState<"title" | "description" | "archive" | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  function edit(field: "title" | "description" | "archive") {
    setDraft(field === "archive" ? "" : issue[field]);
    setError(""); setEditing(field);
  }
  async function save() {
    setBusy(true); setError("");
    try {
      if (editing === "archive") {
        await api.archiveIssue(token, issue.team_id, issue.id);
        onArchived();
      } else if (editing === "title") {
        update(await api.updateIssueProperty(token, issue.team_id, issue.id, { field: "title", value: draft }));
      } else if (editing === "description") {
        await api.updateIssueDescription(token, issue.team_id, issue.id, draft, issue.description);
        update({ ...issue, description: draft });
      }
      setEditing(null);
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  }
  function actions(label: string) {
    return <div className="mt-2 flex justify-end gap-2">
      <button className="issue-action" disabled={busy} onClick={() => setEditing(null)}>取消</button>
      <button className="issue-action primary" disabled={busy || (editing === "title" && !draft.trim())} onClick={() => void save()}>{label}</button>
    </div>;
  }
  return <main className="issue-board" aria-label="Issue 详情">
    <header className="issue-board-header">
      <button className="issue-back" onClick={close} aria-label={issue.archived_at ? "返回归档列表" : "返回 Issues"}>‹ {issue.archived_at ? "已归档" : "Issues"}</button>
      <span aria-hidden="true">/</span><span className="truncate text-sm">{issue.team_name} · <MarkdownTitle text={issue.title} /></span>
    </header>
    <div className="issue-detail-scroll"><div className="issue-detail-layout">
      <div className="issue-detail-main">
        {editing !== "title" && <div className="flex items-start justify-between gap-3"><h1><MarkdownTitle text={issue.title} links /></h1>
          {!issue.archived_at && !editing && <button className="issue-reply shrink-0" onClick={() => edit("title")}>编辑标题</button>}
        </div>}
        {editing === "title" && <div><LiveMarkdownInput autoFocus singleLine className="issue-input w-full" label="Issue 标题" hint="Issue 标题" maxLength={240} value={draft} disabled={busy} onChange={setDraft} />{actions("保存标题")}</div>}
        {error && <p role="alert" className="issue-error">{error}</p>}
        <section className="issue-description-panel">
          <div className="flex items-center justify-between gap-3"><h2>描述</h2>
            {!issue.archived_at && !editing && <button className="issue-reply" onClick={() => edit("description")}>编辑描述</button>}
          </div>
          {editing === "description" ? <><MarkdownEditor value={draft} change={setDraft} disabled={busy} />{actions("保存描述")}</> :
            issue.description ? <MarkdownBody text={issue.description} /> : <p className="text-sm text-[#949ba4]">暂无描述</p>}
          <FileLinks files={issue.attachments} token={token} />
        </section>
        <Discussion issue={issue} token={token} me={me} />
      </div>
      <aside className="issue-properties" aria-label="Issue 属性"><h2>属性</h2>
        <dl className="issue-facts">
          <dt>状态</dt><dd><Dot color={issue.status.color} />{issue.status.name}</dd>
          <dt>优先级</dt><dd>{priorityNames[issue.priority]}</dd>
          <dt>分配人</dt><dd>{issue.assignee_name || "未分配"}</dd>
          <dt>创建人</dt><dd>{issue.creator_name}</dd>
          <dt>排期</dt><dd>{[issue.start_date, issue.end_date].filter(Boolean).join(" – ") || "未排期"}</dd>
          <dt>创建时间</dt><dd>{new Date(issue.created_at).toLocaleString()}</dd>
          <dt>标签</dt><dd>{issue.labels.map(o => <span className="issue-tag" key={o.name}><Dot color={o.color} />{o.name}</span>)}{!issue.labels.length && "无"}</dd>
          {issue.archived_at && <><dt>归档时间</dt><dd>{new Date(issue.archived_at).toLocaleString()}</dd></>}
        </dl>
        {issue.archived_at ? <p className="mt-4 text-sm text-[#b5bac1]">已归档 · 只读</p> :
          editing === "archive" ? <div className="mt-4 text-sm"><p>归档后可查看详情、讨论和下载附件。</p>{actions("确认归档")}</div> :
          !editing && <button className="issue-action mt-4" onClick={() => edit("archive")}>归档 Issue</button>}
      </aside>
    </div></div>
  </main>;
}
