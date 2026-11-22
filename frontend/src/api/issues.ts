import type { Page } from "./types";

export type IssueOptionKind = "status" | "label";
export interface IssueOption {
  kind: IssueOptionKind;
  name: string;
  color: string;
}
export const priorityNames = { none: "无优先级", urgent: "紧急", high: "高", medium: "中", low: "低" } as const;
export type IssuePriority = keyof typeof priorityNames;
export interface IssueFile {
  id: string;
  file_name: string;
}
export interface CreateIssueInput {
  id: string;
  title: string;
  description: string;
  priority: IssuePriority;
  status: string;
  labels: string[];
  assignee_id: string | null;
  start_date: string | null;
  end_date: string | null;
  attachment_ids: string[];
}
export interface Issue extends Omit<CreateIssueInput, "status" | "labels" | "attachment_ids"> {
  team_id: string;
  team_name: string;
  archived_at: string | null;
  creator_id: string;
  creator_name: string;
  creator_avatar_url: string | null;
  assignee_name: string | null;
  created_at: string;
  status: IssueOption;
  labels: IssueOption[];
  attachments: IssueFile[];
}
export interface CommentInput {
  id: string;
  body: string;
  reply_to_id: string | null;
  attachment_ids: string[];
}
export interface IssueComment extends Omit<CommentInput, "attachment_ids"> {
  author_name: string;
  author_avatar_url: string | null;
  root_id: string | null;
  created_at: string;
  attachments: IssueFile[];
}
export type IssuePropertyChange =
  | { field: "title" | "status" | "add_label" | "remove_label"; value: string }
  | { field: "priority"; value: IssuePriority }
  | { field: "assignee"; value: string | null }
  | { field: "schedule"; start_date: string | null; end_date: string | null };

export interface IssuesApi {
  updateIssueProperty(token: string, teamId: string, issueId: string, change: IssuePropertyChange): Promise<Issue>;
  updateIssueDescription(token: string, teamId: string, issueId: string, description: string, previous: string): Promise<void>;
  listIssueComments(token: string, teamId: string, issueId: string): Promise<Page<IssueComment>>;
  createIssueComment(token: string, teamId: string, issueId: string, input: CommentInput): Promise<IssueComment>;
  issueAttachmentUrl(token: string, id: string): Promise<string>;
  getIssue(token: string, teamId: string, issueId: string): Promise<Issue>;
  archiveIssue(token: string, teamId: string, issueId: string): Promise<Issue>;
  listIssues(token: string, teamId?: string, archived?: boolean): Promise<Page<Issue>>;
  createIssue(token: string, teamId: string, input: CreateIssueInput): Promise<Issue>;
  listIssueOptions(token: string, teamId: string): Promise<Page<IssueOption>>;
  createIssueOption(token: string, teamId: string, option: IssueOption): Promise<IssueOption>;
  uploadIssueAttachment(token: string, teamId: string, file: File): Promise<IssueFile>;
}
