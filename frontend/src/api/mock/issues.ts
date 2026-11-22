import type { Issue, IssueComment, IssueOption, IssuesApi } from "../issues";
import { ApiError } from "../errors";
import type { Member } from "../types";
import { nextId, type MockDb } from "./db";

export function mockIssues(db: MockDb, userId: (token: string) => string, membership: (token: string, team: string) => Member): IssuesApi {
  const issues = new Map<string, Issue>();
  const options = new Map<string, IssueOption[]>();
  const discussions = new Map<string, IssueComment[]>();
  const uploads = new Map<string, string>();
  const page = <T,>(items: T[]) => ({ items, has_more: false, next_cursor: null });
  function optionsFor(teamId: string) {
    if (!options.has(teamId)) options.set(teamId, [
      { kind: "status", name: "待处理", color: "#949ba4" }, { kind: "status", name: "进行中", color: "#eab44d" },
      { kind: "status", name: "已完成", color: "#8b80f9" }, { kind: "status", name: "已取消", color: "#818893" },
    ]);
    return options.get(teamId)!;
  }
  function claimFiles(me: Member, ids: string[]) {
    const files = ids.map(id => {
      if (uploads.get(id) !== me.id || db.usedAttachments.has(id)) throw new Error("附件不可用");
      return { id, file_name: db.issueFiles.get(id)!.file_name };
    });
    files.forEach(f => db.usedAttachments.add(f.id));
    return files;
  }
  function getIssue(token: string, teamId: string, id: string) {
    const me = membership(token, teamId);
    const issue = issues.get(id);
    if (!issue || issue.team_id !== teamId) throw new Error("Issue 不存在");
    return { me, issue };
  }
  function activeIssue(token: string, teamId: string, id: string) {
    const ctx = getIssue(token, teamId, id);
    if (ctx.issue.archived_at) throw new ApiError(409, "conflict", "Issue 已归档，只能查看和下载附件");
    return ctx;
  }
  return {
    async getIssue(token, teamId, id) { return getIssue(token, teamId, id).issue; },
    async archiveIssue(token, teamId, id) {
      const { issue } = getIssue(token, teamId, id);
      const archived = { ...issue, archived_at: issue.archived_at ?? new Date().toISOString() };
      issues.set(id, archived);
      return archived;
    },
    async updateIssueProperty(token, teamId, id, change) {
      const { issue } = activeIssue(token, teamId, id);
      const updated = { ...issue };
      switch (change.field) {
        case "title":
          if (!change.value.trim() || change.value.trim().length > 240) throw new Error("标题无效");
          updated.title = change.value.trim();
          break;
        case "status":
        case "add_label":
        case "remove_label": {
          const kind = change.field === "status" ? "status" : "label";
          const option = optionsFor(teamId).find(o => o.kind === kind && o.name === change.value);
          if (!option) throw new Error("团队选项不存在");
          if (change.field === "status") updated.status = option;
          else if (change.field === "remove_label") updated.labels = issue.labels.filter(o => o.name !== option.name);
          else if (!issue.labels.some(o => o.name === option.name)) updated.labels = [...issue.labels, option];
          break;
        }
        case "priority": updated.priority = change.value; break;
        case "assignee": {
          const member = db.members.find(m => m.id === change.value && m.team_id === teamId);
          if (change.value && !member) throw new Error("团队成员不存在");
          updated.assignee_id = change.value;
          updated.assignee_name = member?.display_name ?? null;
          break;
        }
        case "schedule":
          if (change.start_date && change.end_date && change.end_date < change.start_date) throw new Error("截止日期早于开始日期");
          updated.start_date = change.start_date;
          updated.end_date = change.end_date;
          break;
      }
      issues.set(id, updated);
      return updated;
    },
    async updateIssueDescription(token, teamId, id, description, previous) {
      const { issue } = activeIssue(token, teamId, id);
      if (issue.description !== previous && issue.description !== description) throw new Error("描述已被其他成员更新，请刷新后重新编辑");
      issues.set(id, { ...issue, description });
    },
    async listIssueComments(token, teamId, id) {
      getIssue(token, teamId, id);
      return page([...(discussions.get(id) ?? [])]);
    },
    async createIssueComment(token, teamId, id, input) {
      const { me } = activeIssue(token, teamId, id);
      const comments = discussions.get(id) ?? [];
      const existing = comments.find(c => c.id === input.id);
      if (existing) return existing;
      const parent = comments.find(c => c.id === input.reply_to_id);
      if (input.reply_to_id && !parent) throw new Error("回复对象不存在");
      if (!input.body.trim() && !input.attachment_ids.length) throw new Error("请填写评论或添加附件");
      const item = { id: input.id, body: input.body.trim(), root_id: parent?.root_id ?? parent?.id ?? null,
        reply_to_id: input.reply_to_id, author_name: me.display_name, author_avatar_url: me.avatar_url, created_at: new Date().toISOString(), attachments: claimFiles(me, input.attachment_ids) };
      discussions.set(id, [...comments, item]);
      return item;
    },
    async issueAttachmentUrl(token, id) {
      const file = db.issueFiles.get(id);
      if (!file) throw new Error("附件不存在");
      membership(token, file.teamId);
      return file.url;
    },
    async listIssues(token, teamId, archived = false) {
      const uid = userId(token);
      if (teamId) membership(token, teamId);
      const mine = new Set(db.members.filter(m => m.user_id === uid).map(m => m.id));
      return page([...issues.values()].reverse().filter(i => Boolean(i.archived_at) === archived).filter(i => teamId ? i.team_id === teamId :
        i.assignee_id !== null && mine.has(i.assignee_id)));
    },
    async listIssueOptions(token, teamId) {
      membership(token, teamId);
      return page([...optionsFor(teamId)]);
    },
    async createIssueOption(token, teamId, input) {
      membership(token, teamId);
      const opts = optionsFor(teamId);
      const option = { ...input, name: input.name.trim() };
      if (!option.name || option.name.length > 48) throw new Error("请输入有效名称");
      if (opts.some(o => o.kind === option.kind && o.name.toLowerCase() === option.name.toLowerCase())) throw new ApiError(409, "conflict", "同名选项已存在");
      opts.push(option);
      return option;
    },
    async uploadIssueAttachment(token, teamId, file) {
      const me = membership(token, teamId);
      if (!file.size || file.size > (file.type.startsWith("video/") ? 100 : 10) * 1024 * 1024) throw new Error("附件为空或超过大小上限");
      const id = nextId(db);
      uploads.set(id, me.id);
      db.issueFiles.set(id, { teamId, file_name: file.name, url: URL.createObjectURL(file) });
      return { id, file_name: file.name };
    },
    async createIssue(token, teamId, input) {
      const me = membership(token, teamId);
      const previous = issues.get(input.id);
      if (previous && previous.creator_id === me.id) return previous;
      const opts = optionsFor(teamId);
      const status = opts.find(o => o.kind === "status" && o.name === input.status);
      const labels = opts.filter(o => o.kind === "label" && input.labels.includes(o.name));
      const assignee = db.members.find(m => m.id === input.assignee_id && m.team_id === teamId);
      if (previous || !status || !input.title.trim() || labels.length !== input.labels.length || (input.assignee_id && !assignee)
        || (input.start_date && input.end_date && input.end_date < input.start_date)) throw new Error("Issue 字段无效");
      const attachments = claimFiles(me, input.attachment_ids);
      const issue: Issue = { ...input, title: input.title.trim(), team_id: teamId, team_name: db.teams.get(teamId)!.name,
        archived_at: null, creator_id: me.id, creator_name: me.display_name, creator_avatar_url: me.avatar_url, assignee_name: assignee?.display_name ?? null,
        created_at: new Date().toISOString(), status, labels, attachments };
      issues.set(issue.id, issue);
      return issue;
    },
  };
}
