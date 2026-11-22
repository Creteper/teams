import { LiveMarkdownInput } from "../LiveMarkdownInput";
import { MarkdownEditor } from "./MarkdownEditor";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ListBox, Modal, Select } from "@heroui/react";
import { api, fetchAllMembers } from "../../api";
import type { Member, Team, User } from "../../api/types";
import { priorityNames, type IssueOption, type IssuePriority } from "../../api/issues";
import { errorText } from "../../lib/errorText";
import { TeamIcon } from "../TeamIcon";
import { MemberAvatar } from "../MemberAvatar";
import { IssueIcon } from "./IssueIcon";
import { Dot, NewOption, OptionMenuBody, optionNames, PropertyMenu } from "./IssueOptions";

interface Draft {
  title: string; description: string; priority: IssuePriority; start: string; end: string; files: File[];
}
const blankDraft: Draft = { title: "", description: "", priority: "none", start: "", end: "", files: [] };

export function IssueDialog({ token, teams, me, manage, initialStatus, onClose, onCreated }: {
  token: string; teams: Team[]; me: User; manage: boolean; initialStatus?: string; onClose(): void; onCreated(): void;
}) {
  const [teamId, setTeamId] = useState(teams[0]?.id);
  const team = teams.find(t => t.id === teamId) ?? teams[0];
  const [large, setLarge] = useState(false);
  const dialogRef = useRef<HTMLElement>(null);
  const previousSize = useRef<DOMRect | null>(null);
  function toggleSize(event: React.MouseEvent<HTMLButtonElement>) {
    dialogRef.current = event.currentTarget.closest<HTMLElement>('[role="dialog"]');
    previousSize.current = dialogRef.current?.getBoundingClientRect() ?? null;
    setLarge(value => !value);
  }
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    const from = previousSize.current;
    if (!dialog || !from || !dialog.animate || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const to = dialog.getBoundingClientRect();
    const animation = dialog.animate([
      { width: from.width + "px", height: from.height + "px" },
      { width: to.width + "px", height: to.height + "px" },
    ], { duration: 240, easing: "cubic-bezier(.2,.7,.25,1)" });
    return () => animation.cancel();
  }, [large]);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState(blankDraft);
  const title = manage ? "状态与标签" : "新建 Issue";
  return <Modal.Backdrop isOpen isDismissable={!busy} isKeyboardDismissDisabled={busy} onOpenChange={open => { if (!open && !busy) onClose(); }} className="z-40 bg-black/70">
    <Modal.Container placement="center" className="w-full p-3 sm:w-full sm:p-6">
      <Modal.Dialog aria-label={title} className={`issue-dialog ${large ? "issue-maximized" : ""}`}>
        <Modal.Header className="flex shrink-0 flex-row items-center gap-2 p-0">
          {team && <Select aria-label="所属 Team" value={team.id} isDisabled={busy || teams.length === 1}
            onChange={id => { if (typeof id === "string") setTeamId(id); }} className="w-fit min-w-0 max-w-[46%]">
            <Select.Trigger className="issue-team">
              <TeamIcon team={team} size={21} className="rounded-md" />
              <Select.Value className="truncate">{team.name}</Select.Value>
              {teams.length > 1 && <Select.Indicator />}
            </Select.Trigger>
            <Select.Popover className="issue-popover min-w-48">
              <ListBox aria-label="所属 Team">{teams.map(t => <ListBox.Item key={t.id} id={t.id} textValue={t.name}>
                <TeamIcon team={t} size={21} className="rounded-md" /><span className="flex-1 truncate">{t.name}</span><ListBox.ItemIndicator />
              </ListBox.Item>)}</ListBox>
            </Select.Popover>
          </Select>}
          <span aria-hidden="true" className="text-[#80848e]">›</span>
          <Modal.Heading className="flex-1 text-sm font-semibold">{title}</Modal.Heading>
          {!manage && <button type="button" className="issue-icon-button" aria-label={large ? "还原窗口" : "最大化"} onClick={toggleSize}><IssueIcon name={large ? "shrink" : "expand"} /></button>}
          <button type="button" disabled={busy} className="issue-icon-button text-xl" aria-label="关闭" onClick={onClose}>×</button>
        </Modal.Header>
        {team && <TeamIssueForm key={team.id} {...{ team, token, me, manage, initialStatus, busy, setBusy, draft, setDraft, onCreated }} />}
      </Modal.Dialog>
    </Modal.Container>
  </Modal.Backdrop>;
}

function TeamIssueForm({ team, token, me, manage, initialStatus, busy, setBusy, draft, setDraft, onCreated }: {
  team: Team; token: string; me: User; manage: boolean; initialStatus?: string; busy: boolean; setBusy: (v: boolean) => void;
  draft: Draft; setDraft: React.Dispatch<React.SetStateAction<Draft>>; onCreated(): void;
}) {
  const [options, setOptions] = useState<IssueOption[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [status, setStatus] = useState("");
  const [labels, setLabels] = useState<string[]>([]);
  const [assignee, setAssignee] = useState("");
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [progress, setProgress] = useState("");
  const uploadIds = useRef(new Map<File, string>());
  const [issueId] = useState(() => crypto.randomUUID());
  const fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let active = true;
    setError("");
    Promise.all([api.listIssueOptions(token, team.id), manage ? Promise.resolve([]) : fetchAllMembers(api, token, team.id)])
      .then(([opts, ms]) => {
        if (!active) return;
        const statuses = opts.items.filter(o => o.kind === "status");
        setOptions(opts.items); setStatus(statuses.find(o => o.name === initialStatus)?.name ?? statuses[0]?.name ?? ""); setMembers(ms); setLoaded(true);
      }).catch(e => { if (active) setError(errorText(e)); });
    return () => { active = false; };
  }, [team.id, token, attempt, manage, initialStatus]);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft(d => ({ ...d, [key]: value }));
  async function saveOption(o: IssueOption) {
    const created = await api.createIssueOption(token, team.id, o);
    setOptions(old => [...old, created]);
  }
  async function submit() {
    if (busy || !draft.title.trim() || !loaded) return;
    setError("");
    if (draft.start && draft.end && draft.start > draft.end) { setError("截止日期早于开始日期"); return; }
    setBusy(true);
    try {
      const ids: string[] = [];
      for (const [i, file] of draft.files.entries()) {
        setProgress(`上传附件 ${i + 1}/${draft.files.length}`);
        let id = uploadIds.current.get(file);
        if (!id) {
          const result = await api.uploadIssueAttachment(token, team.id, file);
          id = result.id;
          uploadIds.current.set(file, id);
        }
        ids.push(id);
      }
      setProgress("创建中…");
      await api.createIssue(token, team.id, { id: issueId, title: draft.title.trim(), description: draft.description,
        status, labels, assignee_id: assignee || null, priority: draft.priority, start_date: draft.start || null, end_date: draft.end || null, attachment_ids: ids });
      onCreated();
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(false); setProgress(""); }
  }

  if (!loaded) return <div className="py-8 text-sm text-[#b5bac1]">{error ? <><span role="alert">{error}</span> <button className="issue-action" onClick={() => setAttempt(v => v + 1)}>重试</button></> : "正在加载…"}</div>;
  if (manage) return <div className="mt-5 grid gap-5 overflow-auto sm:grid-cols-2">
    {(["status", "label"] as const).map(kind => <section className="issue-option-panel" key={kind}>
      <h3 className="mb-3 font-semibold">{optionNames[kind]}</h3>
      <ul className="mb-4 flex min-h-8 flex-wrap content-start gap-2">
        {options.filter(o => o.kind === kind).map(o => <li className="issue-tag" key={o.name}><Dot color={o.color} />{o.name}</li>)}
        {!options.some(o => o.kind === kind) && <li className="text-sm text-[#949ba4]">暂无{optionNames[kind]}</li>}
      </ul>
      <NewOption kind={kind} save={saveOption} />
    </section>)}
  </div>;
  const currentStatus = options.find(o => o.kind === "status" && o.name === status);
  return <fieldset disabled={busy} className="issue-editor">
    <LiveMarkdownInput autoFocus singleLine label="Issue 标题" className="issue-title" hint="Issue 标题（支持 Markdown）"
      maxLength={240} disabled={busy} value={draft.title} onChange={title => set("title", title)} />
    <MarkdownEditor value={draft.description} change={text => set("description", text)} />
    {draft.files.length > 0 && <div className="flex max-h-24 flex-wrap gap-2 overflow-auto">{draft.files.map((f, i) =>
      <span key={i} className="issue-tag max-w-full"><IssueIcon name="attach" size={14} /><span className="truncate">{f.name}</span><button type="button" aria-label={"移除 " + f.name} onClick={() => set("files", draft.files.filter((_, n) => n !== i))}>×</button></span>)}</div>}
    <div className="flex flex-wrap items-center gap-2">
      <PropertyMenu label="状态" trigger={<><Dot color={currentStatus?.color ?? "#949ba4"} />{status}</>}>
        {close => <OptionMenuBody kind="status" options={options} selected={[status]} save={saveOption} choose={o => { setStatus(o.name); close(); }} />}
      </PropertyMenu>
      <PropertyMenu label="优先级" trigger={<><IssueIcon name="priority" size={15} />{draft.priority === "none" ? "优先级" : priorityNames[draft.priority]}</>}>
        {close => Object.entries(priorityNames).map(([key, name]) => <button type="button" key={key} className="issue-menu-row" aria-pressed={draft.priority === key} onClick={() => { set("priority", key as IssuePriority); close(); }}>{name}</button>)}
      </PropertyMenu>
      <PropertyMenu label="分配人" trigger={<><IssueIcon name="user" size={15} />{members.find(m => m.id === assignee)?.display_name ?? "分配人"}</>}>
        {close => <div className="max-h-60 overflow-auto"><button type="button" className="issue-menu-row" onClick={() => { setAssignee(""); close(); }}>未分配</button>
          {members.map(m => <button type="button" className="issue-menu-row" key={m.id} aria-label={m.display_name} aria-pressed={m.id === assignee} onClick={() => { setAssignee(m.id); close(); }}><MemberAvatar member={m} size={20} />{m.display_name}</button>)}</div>}
      </PropertyMenu>
      <PropertyMenu label="标签" trigger={<><IssueIcon name="label" size={15} />{labels.length ? labels.join("、") : "标签"}</>}>
        {close => <OptionMenuBody kind="label" options={options} selected={labels} save={saveOption} closeAfterCreate={close} choose={o => setLabels(old => old.includes(o.name) ? old.filter(n => n !== o.name) : [...old, o.name])} />}
      </PropertyMenu>
      <PropertyMenu label="排期" trigger={<><IssueIcon name="calendar" size={15} />{[draft.start, draft.end].filter(Boolean).join(" – ") || "排期"}</>}>
        {close => <div className="grid gap-2">{(["start", "end"] as const).map(key => <label key={key} className="flex items-center gap-2">{key === "start" ? "开始" : "截止"}日期<input type="date" className="issue-input" value={draft[key]} onChange={e => set(key, e.target.value)} /></label>)}<button className="issue-action" type="button" onClick={close}>完成</button></div>}
      </PropertyMenu>
    </div>
    <footer className="mt-2 flex shrink-0 flex-wrap items-center gap-3 border-t border-white/10 pt-3">
      <input type="file" ref={fileInput} multiple hidden onChange={e => { set("files", [...draft.files, ...Array.from(e.target.files ?? [])]); e.target.value = ""; }} />
      <button type="button" className="issue-icon-button" aria-label="上传附件" title="上传附件" onClick={() => fileInput.current?.click()}><IssueIcon name="attach" /></button>
      <span className="flex flex-1 items-center gap-1.5 text-xs text-[#b5bac1]"><MemberAvatar member={me} size={20} />创建人 · {me.display_name}</span>
      <button className="issue-action primary" type="button" disabled={busy || !draft.title.trim()} onClick={() => void submit()}>{busy ? progress : "创建 Issue"}</button>
    </footer>
    {error && <p role="alert" className="issue-error">{error}</p>}
  </fieldset>;
}
