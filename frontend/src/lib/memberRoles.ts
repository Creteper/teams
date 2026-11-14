import { errorText } from "./errorText";
import { ApiError } from "../api/errors";
import type { Member, Team } from "../api/types";

/** 成员列表 ⋯ 菜单里能做的角色操作 */
export type RoleAction = "promote" | "demote";

/**
 * docs/api.md §3：PATCH /teams/{team_id}/members/{member_id} 权限 owner/admin，body {role: "admin"|"member"}，不能改 owner 和 bot。
 * 入口规则：我是 owner/admin 才显示；目标是 owner、bot 或我自己都不显示；member → 设为管理员，admin → 取消管理员。
 * （admin 能否取消另一个 admin、能否改自己，文档没写清，见汇报；这里按文档只要求 owner/admin，不额外限制 admin。）
 */
export function roleActionFor(myRole: string | null | undefined, myMemberId: string, target: Member): RoleAction | null {
  if (myRole !== "owner" && myRole !== "admin") return null;
  if (target.type !== "user" || target.id === myMemberId) return null;
  if (target.role === "member") return "promote";
  if (target.role === "admin") return "demote";
  return null; // owner / bot / 未知角色
}

export const ROLE_ACTION_TEXT: Record<RoleAction, string> = { promote: "设为管理员", demote: "取消管理员" };

/** 粗略判断接口返回是不是 Member 对象（PATCH 成员的响应体文档未写明） */
export function isMember(v: unknown): v is Member {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o.id === "string" && typeof o.role === "string" && typeof o.team_id === "string" && (o.type === "user" || o.type === "bot");
}

/** 把某个成员的角色改成 role（位置不变；不存在则原样返回） */
export function applyRole(members: Member[], memberId: string, role: Member["role"]): Member[] {
  return members.map((m) => (m.id === memberId ? { ...m, role } : m));
}

/** member.joined / member.updated / 接口返回：原位替换，不存在则追加 */
export function upsertMember(members: Member[], next: Member): Member[] {
  return members.some((m) => m.id === next.id) ? members.map((m) => (m.id === next.id ? next : m)) : [...members, next];
}

/** 推送里的 Member 是我自己时，同步 team.my_role（被设为/取消管理员后入口和权限立刻跟着变） */
export function syncMyRole(team: Team | null, updated: Member): Team | null {
  if (!team || updated.id !== team.my_member_id) return team;
  if (updated.role !== "owner" && updated.role !== "admin" && updated.role !== "member") return team;
  return updated.role === team.my_role ? team : { ...team, my_role: updated.role };
}

/**
 * 乐观改角色：先在列表里改，再调接口；成功用返回的 Member 覆盖，失败回滚并返回中文提示（成功返回 null）。
 * 回滚只在当前值仍是乐观写入的值时进行，避免覆盖期间到达的 member.updated 推送。
 */
export async function optimisticRoleChange(
  target: Member,
  action: RoleAction,
  update: (fn: (prev: Member[]) => Member[]) => void,
  call: (role: "admin" | "member") => Promise<Member | null>,
): Promise<string | null> {
  const prevRole = target.role;
  const nextRole = action === "promote" ? "admin" : "member";
  update((prev) => applyRole(prev, target.id, nextRole));
  try {
    const res = await call(nextRole);
    if (res) update((prev) => upsertMember(prev, res));
    return null;
  } catch (e) {
    update((prev) => prev.map((m) => (m.id === target.id && m.role === nextRole ? { ...m, role: prevRole } : m)));
    return roleChangeErrorText(e, action, target.display_name);
  }
}

/** 改角色失败的中文提示 */
export function roleChangeErrorText(err: unknown, action: RoleAction, name: string): string {
  const what = `${ROLE_ACTION_TEXT[action]}失败（${name}）`;
  if (err instanceof ApiError) {
    if (err.status === 0) return `${what}：网络异常，请稍后再试`;
    if (err.status === 403) return `${what}：你没有权限修改这个成员的角色`;
    if (err.status === 404) return `${what}：该成员不存在或已离开 team`;
    if (err.code === "rate_limited") return `${what}：${errorText(err)}`;
    return `${what}：${errorText(err)}${err.requestId && !errorText(err).includes(err.requestId) ? `（请求编号 ${err.requestId}）` : ""}`;
  }
  return `${what}：网络异常，请稍后再试`;
}
