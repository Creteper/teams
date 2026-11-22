import { useEffect, useState, type ReactNode } from "react";
import { Disclosure } from "@heroui/react";
import { api } from "../../api";
import type { Team, User } from "../../api/types";
import { priorityNames, type Issue } from "../../api/issues";
import { errorText } from "../../lib/errorText";
import { Link, useMatch, useNavigate, useSearchParams } from "react-router";
import { MarkdownTitle } from "./MarkdownEditor";
import { MemberAvatar } from "../MemberAvatar";
import { IssueTableMenu, type TableMenuTarget, type TableField } from "./IssueTableMenu";
import { IssueDetail } from "./IssueDetail";
import { IssueDialog } from "./IssueDialog";
import { IssueIcon } from "./IssueIcon";
import { IssueTimeline } from "./IssueTimeline";
import "./issues.css";

function schedule(i: Issue) {
  return [i.start_date, i.end_date].filter(Boolean).join(" – ") || "未排期";
}
// Use the higher-contrast foreground for each custom sRGB background.
function cellColors(backgroundColor: string) {
  const [r, g, b] = [1, 3, 5].map(offset => {
    const value = parseInt(backgroundColor.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const color = (luminance + 0.05) / 0.05 >= 1.05 / (luminance + 0.05) ? "#000" : "#fff";
  return { backgroundColor, color };
}

function IssueTable({ issues, personal, open, create, token, update }: {
  token: string; update(issue: Issue): void; issues: Issue[]; personal: boolean; open(i: Issue): void; create?: (status: string) => void;
}) {
  const [target, setTarget] = useState<TableMenuTarget | null>(null);
  const editing = target && issues.find(i => i.id === target.issueId);
  function cell(i: Issue, field: TableField, label: string, content: ReactNode, className = "") {
    if (i.archived_at && field !== "attachments") return <span className={className}>{content}</span>;
    return <button type="button" className={"issue-cell-button " + className} aria-haspopup="dialog"
      aria-label={label} aria-expanded={target?.issueId === i.id && target.field === field}
      onClick={e => { e.stopPropagation(); setTarget({ issueId: i.id, field, trigger: e.currentTarget }); }}>{content}</button>;
  }
  const groups = new Map<string, Issue[]>();
  for (const i of issues) {
    const group = groups.get(i.status.name);
    if (group) group.push(i); else groups.set(i.status.name, [i]);
  }
  return <div className="space-y-2">{[...groups.entries()].map(([name, rows]) =>
    <Disclosure defaultExpanded key={name}>
      <div className="issue-group-header">
        <Disclosure.Heading className="min-w-0 flex-1">
          <Disclosure.Trigger className="issue-group-toggle">
            <span aria-hidden="true" className="issue-caret" />
            <span aria-hidden="true" className="issue-status-ring" style={{ borderColor: rows[0].status.color }} />
            <span className="truncate">{name}</span><span className="issue-group-count">{rows.length}</span>
          </Disclosure.Trigger>
        </Disclosure.Heading>
        {create && <button type="button" className="issue-icon-button mr-1" aria-label={`在「${name}」中新建 Issue`} onClick={() => create(name)}>
          <IssueIcon name="plus" size={16} />
        </button>}
      </div>
      <Disclosure.Content><div className="overflow-x-auto"><table className="issue-table">
        <thead><tr><th>标题</th>{personal && <th>Team</th>}<th>分配人</th><th>状态</th><th>优先级</th><th>标签</th><th>排期</th><th>创建人</th><th>附件</th></tr></thead>
        <tbody>{rows.map(i => <tr key={i.id} className="cursor-pointer" onClick={() => open(i)} onContextMenu={e => {
          if (i.archived_at) return;
          e.preventDefault();
          const trigger = e.currentTarget.querySelector<HTMLButtonElement>(".issue-row-title")!;
          setTarget({ issueId: i.id, field: "row", trigger, point: { x: e.clientX, y: e.clientY } });
        }}>
          <td><button className="issue-row-title"><MarkdownTitle text={i.title} /></button></td>
          {personal && <td>{i.team_name}</td>}
          <td>{cell(i, "assignee", "修改分配人", i.assignee_name || "未分配")}</td>
          <td className="issue-status-cell" style={cellColors(i.status.color)}>{cell(i, "status", "修改状态", i.status.name)}</td>
          <td>{cell(i, "priority", "修改优先级", priorityNames[i.priority])}</td>
          <td className="issue-label-cell">{cell(i, "label", "修改标签", i.labels.length ? i.labels.map(o =>
            <span key={o.name} style={cellColors(o.color)}>{o.name}</span>) : "—", i.labels.length ? "issue-label-bands" : "")}</td>
          <td>{cell(i, "schedule", "修改排期", schedule(i))}</td>
          <td><span className="inline-flex items-center gap-2 align-middle"><MemberAvatar
            member={{ display_name: i.creator_name, avatar_url: i.creator_avatar_url }} size={22} />{i.creator_name}</span></td>
          <td>{cell(i, "attachments", "查看附件", i.attachments.length ? <span className="issue-tag"><IssueIcon name="attach" size={13} />{i.attachments.length}</span> : "—")}</td>
        </tr>)}</tbody>
      </table></div></Disclosure.Content>
    </Disclosure>)}
    {target && editing && <IssueTableMenu key={target.issueId + target.field} target={target} token={token} issue={editing} update={update}
      close={() => setTarget(current => current === target ? null : current)} />}
  </div>;
}

type BoardProps = { token: string; me: User; teams: Team[]; team?: Team };

export function IssueBoard(props: BoardProps) {
  const personalArchive = useMatch("/issues/archive");
  const teamArchive = useMatch("/teams/:teamId/issues/archive");
  const archived = Boolean(personalArchive || teamArchive);
  return <BoardPage key={String(archived) + (props.team?.id ?? "")} {...props} archived={archived} />;
}

function BoardPage({ token, me, teams, team, archived }: BoardProps & { archived: boolean }) {
  const base = team ? `/teams/${team.id}/issues` : "/issues";
  const navigate = useNavigate();
  const [view, setView] = useState<"table" | "timeline">("table");
  const [issues, setIssues] = useState<Issue[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [dialog, setDialog] = useState<"new" | "manage" | null>(null);
  const [initialStatus, setInitialStatus] = useState<string>();
  const [params, setParams] = useSearchParams();
  const selectedId = params.get("issue");
  const detail = issues.find(i => i.id === selectedId);
  function selectIssue(issue: Issue | null) {
    setParams(old => {
      const next = new URLSearchParams(old);
      if (issue) next.set("issue", issue.id); else next.delete("issue");
      return next;
    });
  }
  const teamId = team?.id;
  useEffect(() => {
    let active = true;
    setError(""); setLoading(true);
    api.listIssues(token, teamId, archived).then(async page => {
      if (!active) return;
      if (selectedId && !page.items.some(i => i.id === selectedId)) {
        // An existing detail link may outlive the move into the archive.
        const item = teamId ? await api.getIssue(token, teamId, selectedId) :
          (await api.listIssues(token, undefined, !archived)).items.find(i => i.id === selectedId);
        if (!active) return;
        if (item && Boolean(item.archived_at) !== archived) {
          navigate(base + (item.archived_at ? "/archive" : "") + "?issue=" + item.id, { replace: true });
          return;
        }
      }
      setIssues(page.items);
    })
      .catch(e => { if (active) setError(errorText(e)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [teamId, token, archived, selectedId, base, navigate, revision, teams.map(t => t.id).join(",")]);
  if (detail) return <IssueDetail key={detail.id} me={me} token={token} issue={detail} close={() => selectIssue(null)}
    update={changed => setIssues(items => items.map(i => i.id === changed.id ? changed : i))}
    onArchived={() => navigate(base + "/archive?issue=" + detail.id, { replace: true })} />;
  const choices = team ? [team] : teams;
  return <main className="issue-board">
    <header className="issue-board-header"><IssueIcon /><h1>{team ? <><span>{team.name}</span> <b aria-hidden="true">/</b> Issues</> : "我的 Issues"}{archived && <> / 已归档</>}</h1></header>
    <div className="issue-toolbar">
      <div className="flex gap-1" aria-label="视图">
        <button className="issue-view" aria-pressed={view === "table"} onClick={() => setView("table")}><IssueIcon name="table" size={16} />表格</button>
        <button className="issue-view" aria-pressed={view === "timeline"} onClick={() => setView("timeline")}><IssueIcon name="timeline" size={16} />时间线</button>
      </div>
      <div className="ml-auto flex gap-2">
        <Link className="issue-action" to={archived ? base : base + "/archive"}>{archived ? "返回 Issues" : "已归档"}</Link>
        {!archived && <>
          <button className="issue-action" disabled={!choices.length} onClick={() => setDialog("manage")}><IssueIcon name="settings" size={15} />状态与标签</button>
        <button className="issue-action primary" disabled={!choices.length} onClick={() => { setInitialStatus(undefined); setDialog("new"); }}><IssueIcon name="plus" size={15} />新建 Issue</button>
        </>}
      </div>
    </div>
    <div className="min-h-0 flex-1 overflow-auto p-4 sm:p-6">
      {error ? <div role="alert" className="issue-error">{error} <button className="issue-action" onClick={() => setRevision(v => v + 1)}>重试</button></div> :
        loading ? <p className="text-sm text-[#b5bac1]">正在加载…</p> :
        view === "timeline" ? <IssueTimeline issues={issues} open={selectIssue} /> :
        !issues.length ? <div className="issue-empty"><IssueIcon size={30} /><h2>{archived ? "暂无已归档 Issue" : "暂无 Issue"}</h2>{!archived && <p>{team ? "在此创建团队的第一个 Issue。" : "分配给你的 Issue 会显示在这里。"}</p>}</div> :
        <IssueTable token={token} update={changed => setIssues(items => {
          const mine = teams.find(t => t.id === changed.team_id)?.my_member_id;
          if (!team && changed.assignee_id !== mine) return items.filter(i => i.id !== changed.id);
          return items.map(i => i.id === changed.id ? changed : i);
        })} issues={issues} personal={!team} open={selectIssue} create={team && !archived ? status => { setInitialStatus(status); setDialog("new"); } : undefined} />}
    </div>
    {dialog && choices.length > 0 && <IssueDialog token={token} teams={choices} me={me} manage={dialog === "manage"} initialStatus={initialStatus} onClose={() => setDialog(null)} onCreated={() => { setDialog(null); setRevision(v => v + 1); }} />}
  </main>;
}
