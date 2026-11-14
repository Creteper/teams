import type { MemberRole } from "../api/types";

const ROLE_TEXT: Record<MemberRole, string> = {
  owner: "所有者",
  admin: "管理员",
  member: "成员",
  bot: "Bot",
};

/** 角色中文名：所有者 / 管理员 / 成员（bot → Bot）；未知值原样返回 */
export function roleLabel(role: string | null | undefined): string {
  if (!role) return "";
  return ROLE_TEXT[role as MemberRole] ?? role;
}

export function isManager(role: string | null | undefined): boolean {
  return role === "owner" || role === "admin";
}
