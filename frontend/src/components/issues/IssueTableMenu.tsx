import { Dropdown, Popover } from "@heroui/react";
import { useEffect, useRef, useState } from "react";
import { api, fetchAllMembers } from "../../api";
import { priorityNames, type Issue, type IssueOption, type IssuePriority, type IssuePropertyChange } from "../../api/issues";
import type { Member } from "../../api/types";
import { errorText } from "../../lib/errorText";
import { MemberAvatar } from "../MemberAvatar";
import { FileLinks } from "./FileLinks";
import { IssueIcon } from "./IssueIcon";
import { OptionMenuBody } from "./IssueOptions";

const fields = {
  status: { label: "状态", icon: "issues" }, priority: { label: "优先级", icon: "priority" },
  assignee: { label: "分配人", icon: "user" }, label: { label: "标签", icon: "label" },
  schedule: { label: "排期", icon: "calendar" }, attachments: { label: "附件", icon: "attach" },
} as const;
export type TableField = keyof typeof fields;
export type TableMenuTarget = {
  issueId: string; field: TableField | "row"; trigger: HTMLElement; point?: { x: number; y: number };
};

export function IssueTableMenu({ target, issue, token, close, update }: {
  target: TableMenuTarget; issue: Issue; token: string; close(): void; update(issue: Issue): void;
}) {
  const triggerRef = useRef(target.trigger);
  const panelClass = "issue-popover issue-table-panel";
  useEffect(() => {
    // Non-modal popovers leave the table interactive. Capture outside presses even
    // when another overlay stops propagation or the blank area cannot take focus.
    function outside(event: PointerEvent) {
      if (event.composedPath().some(el => el instanceof Element &&
        (el.classList.contains("issue-table-panel") || el.hasAttribute("data-issue-option-colors")))) return;
      close();
    }
    function dismiss(event: KeyboardEvent) {
      if (event.key === "Escape" && document.activeElement === document.body) {
        close();
        target.trigger.focus({ preventScroll: true });
      }
    }
    window.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", dismiss);
    return () => {
      window.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", dismiss);
    };
  }, [target, close]);

  function editor(field: TableField) {
    return field === "attachments"
      ? issue.attachments.length ? <FileLinks menu files={issue.attachments} token={token} /> : <p className="px-2 py-1 text-sm text-[#b5bac1]">暂无附件</p>
      : <PropertyEditor {...{ field, issue, token, close, update }} />;
  }
  if (target.field !== "row") return <Popover.Content isOpen isNonModal triggerRef={triggerRef} placement="bottom start" offset={4}
    onOpenChange={open => { if (!open) close(); }} className={panelClass}>
    <Popover.Dialog aria-label={fields[target.field].label} className="p-0">{editor(target.field)}</Popover.Dialog>
  </Popover.Content>;

  const point = target.point;
  return <Dropdown isOpen onOpenChange={open => { if (!open) close(); }}>
    <Dropdown.Popover triggerRef={triggerRef} isNonModal placement="bottom start" offset={4} className={panelClass}
      getTargetRect={point ? () => new DOMRect(point.x, point.y, 0, 0) : undefined}>
      <Dropdown.Menu aria-label="Issue 操作" className="w-52 p-0">
        {(Object.keys(fields) as TableField[]).map(field => <Dropdown.SubmenuTrigger key={field} delay={120}>
          <Dropdown.Item id={field} textValue={fields[field].label} className="issue-menu-row">
            <IssueIcon name={fields[field].icon} size={15} /><span className="flex-1">{fields[field].label}</span><Dropdown.SubmenuIndicator />
          </Dropdown.Item>
          <Dropdown.Popover className={panelClass} placement="end top" offset={4}>
            <Popover.Dialog aria-label={fields[field].label} className="p-0">{editor(field)}</Popover.Dialog>
          </Dropdown.Popover>
        </Dropdown.SubmenuTrigger>)}
      </Dropdown.Menu>
    </Dropdown.Popover>
  </Dropdown>;
}

function PropertyEditor({ field, issue, token, close, update }: {
  field: Exclude<TableField, "attachments">; issue: Issue; token: string; close(): void; update(i: Issue): void;
}) {
  const [options, setOptions] = useState<IssueOption[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const needsOptions = field === "label" || field === "status";
  const needsLoad = needsOptions || field === "assignee";
  const [loading, setLoading] = useState(needsLoad);
  const [loadError, setLoadError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [start, setStart] = useState(issue.start_date ?? "");
  const [end, setEnd] = useState(issue.end_date ?? "");
  useEffect(() => {
    if (!needsLoad) return;
    let active = true;
    setLoading(true); setLoadError("");
    const request = needsOptions
      ? api.listIssueOptions(token, issue.team_id).then(p => { if (active) setOptions(p.items); })
      : fetchAllMembers(api, token, issue.team_id).then(list => { if (active) setMembers(list); });
    request.catch(e => { if (active) setLoadError(errorText(e)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [needsOptions, needsLoad, token, issue.team_id, attempt]);

  async function apply(change: IssuePropertyChange) {
    setBusy(true); setError("");
    try {
      update(await api.updateIssueProperty(token, issue.team_id, issue.id, change));
      if (field !== "label") close();
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  }
  if (loading) return <p role="status" className="p-2 text-sm">正在加载…</p>;
  if (loadError) return <div role="alert" className="issue-error">{loadError} <button className="issue-action" onClick={() => setAttempt(v => v + 1)}>重试</button></div>;
  return <fieldset disabled={busy} aria-busy={busy} className="w-60 max-w-full">
    {(field === "status" || field === "label") && <OptionMenuBody kind={field} options={options}
      selected={field === "status" ? [issue.status.name] : issue.labels.map(o => o.name)}
      choose={o => void apply({ field: field === "status" ? "status" : issue.labels.some(l => l.name === o.name) ? "remove_label" : "add_label", value: o.name })}
      save={async o => { const saved = await api.createIssueOption(token, issue.team_id, o); setOptions(list => [...list, saved]); }} />}
    {field === "priority" && (Object.keys(priorityNames) as IssuePriority[]).map(p =>
      <button className="issue-menu-row" key={p} aria-pressed={issue.priority === p} onClick={() => void apply({ field, value: p })}>
        <IssueIcon name="priority" size={15} /><span className="flex-1">{priorityNames[p]}</span>{issue.priority === p && "✓"}
      </button>)}
    {field === "assignee" && <>
      <input className="issue-input mb-2 w-full" aria-label="搜索分配人" placeholder="搜索分配人…" value={query} onChange={e => setQuery(e.target.value)} />
      <div className="max-h-60 overflow-auto">
        <button className="issue-menu-row" aria-pressed={!issue.assignee_id} onClick={() => void apply({ field, value: null })}>未分配</button>
        {members.filter(m => m.display_name.toLowerCase().includes(query.trim().toLowerCase())).map(m =>
          <button className="issue-menu-row" key={m.id} aria-pressed={issue.assignee_id === m.id} onClick={() => void apply({ field, value: m.id })}>
            <MemberAvatar member={m} size={20} /><span className="flex-1 truncate">{m.display_name}</span>{issue.assignee_id === m.id && "✓"}
          </button>)}
      </div></>}
    {field === "schedule" && <form className="grid gap-2 text-sm" onSubmit={e => { e.preventDefault(); void apply({ field, start_date: start || null, end_date: end || null }); }}>
      <label className="grid gap-1">开始日期<input className="issue-input" type="date" max={end || undefined} value={start} onChange={e => setStart(e.target.value)} /></label>
      <label className="grid gap-1">截止日期<input className="issue-input" type="date" min={start || undefined} value={end} onChange={e => setEnd(e.target.value)} /></label>
      <button className="issue-action primary">保存排期</button>
    </form>}
    {error && <p role="alert" className="issue-error">{error}</p>}
  </fieldset>;
}
