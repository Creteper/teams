import { Button, CloseButton } from "@heroui/react";
import { useState } from "react";
import type { Member } from "../api/types";
import { roleLabel } from "../lib/roles";
import { ROLE_ACTION_TEXT, roleActionFor, type RoleAction } from "../lib/memberRoles";
import { BotBadge, MemberAvatar } from "./MemberAvatar";
import { CrownIcon } from "./ui";
import { RowActionsMenu, type RowAction } from "./RowActionsMenu";

export interface MemberRoleControls {
  myRole: string | null | undefined;
  myMemberId: string;
  /** 正在提交的成员 id（期间菜单按钮禁用） */
  pendingId?: string | null;
  onAction(member: Member, action: RoleAction): void;
}

/**
 * 右侧成员列表：按“成员 / Bot”分组；所有者带皇冠，管理员名字用另一种颜色；bot 带 BOT 标记。
 * 所有者/管理员才显示“邀请成员”；对可操作的成员显示悬浮「⋯」菜单（右键同样打开）：设为管理员 / 取消管理员。
 */
export function MemberList({
  members,
  onInvite,
  roles,
  notice,
  onDismissNotice,
  onProfile,
}: {
  members: Member[];
  onInvite?: () => void;
  roles?: MemberRoleControls;
  /** 改角色失败等提示 */
  notice?: string | null;
  onDismissNotice?: () => void;
  /** 查看资料：所有人对任何成员可用（含自己、owner、bot） */
  onProfile?: (member: Member) => void;
}) {
  const order = { owner: 0, admin: 1, member: 2, bot: 3 } as const;
  const users = members.filter((m) => m.type === "user").sort((a, b) => order[a.role] - order[b.role]);
  const bots = members.filter((m) => m.type === "bot");
  return (
    <aside aria-label="成员列表" className="hidden w-60 shrink-0 overflow-y-auto bg-[#2b2d31] px-2 py-4 lg:block">
      {onInvite ? (
        <Button
          variant="ghost"
          fullWidth
          onPress={onInvite}
          className="mb-4 h-auto min-h-0 justify-start rounded px-2 py-1.5 text-left text-sm font-normal text-brand-light hover:bg-[#35373c] hover:text-white data-[hovered=true]:bg-[#35373c] data-[pressed=true]:scale-100"
        >
          ＋ 邀请成员
        </Button>
      ) : null}
      {notice ? (
        <div role="alert" className="mb-3 flex items-start gap-2 rounded-md bg-[#f23f43]/15 px-2.5 py-2 text-xs text-[#ff8a8c]">
          <span className="flex-1">{notice}</span>
          <CloseButton aria-label="关闭提示" className="h-auto min-h-0 size-5 min-w-5 rounded bg-transparent hover:bg-transparent data-[hovered=true]:bg-transparent [&_svg]:size-3 text-[#ff8a8c] hover:text-white" onPress={onDismissNotice} />
        </div>
      ) : null}
      <Group title={`成员 — ${users.length}`} items={users} roles={roles} onProfile={onProfile} />
      <Group title={`Bot — ${bots.length}`} items={bots} roles={roles} onProfile={onProfile} />
    </aside>
  );
}

function Group({
  title,
  items,
  roles,
  onProfile,
}: {
  title: string;
  items: Member[];
  roles?: MemberRoleControls;
  onProfile?: (member: Member) => void;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  /** 菜单项：查看资料（所有人）+ 设为/取消管理员（按 §3 权限） */
  const actionsOf = (m: Member): RowAction[] => {
    const out: RowAction[] = [];
    if (onProfile) out.push({ id: "profile", text: "查看资料" });
    const action = roles ? roleActionFor(roles.myRole, roles.myMemberId, m) : null;
    if (action) out.push({ id: action, text: ROLE_ACTION_TEXT[action], danger: action === "demote" });
    return out;
  };
  if (items.length === 0) return null;
  return (
    <section className="mb-5">
      <h3 className="mb-1 px-2 text-xs font-semibold uppercase tracking-wide text-[#949ba4]">{title}</h3>
      <ul>
        {items.map((m) => {
          const action = roles ? roleActionFor(roles.myRole, roles.myMemberId, m) : null;
          const open = openId === m.id;
          return (
            <li
              key={m.id}
              data-type={m.type}
              data-role={m.role}
              data-member-id={m.id}
              title={`@${m.username}${m.type === "user" ? ` · ${roleLabel(m.role)}` : ""}`}
              onContextMenu={
                actionsOf(m).length > 0
                  ? (e) => {
                      e.preventDefault();
                      setOpenId(m.id);
                    }
                  : undefined
              }
              className={`group flex items-center gap-3 rounded px-2 py-1.5 hover:bg-[#35373c] ${open ? "bg-[#35373c]" : ""}`}
            >
              <MemberAvatar member={m} size={32} />
              <span
                className={`truncate text-[15px] ${
                  m.role === "owner" ? "font-medium text-[#f0b232]" : m.role === "admin" ? "font-medium text-brand-light" : "text-[#dbdee1]"
                }`}
              >
                {m.display_name}
              </span>
              {m.role === "owner" ? <CrownIcon /> : null}
              {m.role === "admin" ? (
                <span className="rounded bg-brand-soft px-1 text-[10px] font-semibold text-brand-light">{roleLabel("admin")}</span>
              ) : null}
              {m.type === "bot" ? <BotBadge /> : null}
              <RowActionsMenu
                label={`${m.display_name} 的成员操作`}
                actions={actionsOf(m)}
                open={open}
                onOpenChange={(o) => setOpenId(o ? m.id : null)}
                disabled={roles?.pendingId === m.id}
                onAction={(id) => (id === "profile" ? onProfile?.(m) : action && roles ? roles.onAction(m, action) : undefined)}
              />
            </li>
          );
        })}
      </ul>
    </section>
  );
}
