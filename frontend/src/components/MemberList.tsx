import { useState } from "react";
import { Dropdown, Label } from "@heroui/react";
import type { Member } from "../api/types";
import { roleLabel } from "../lib/roles";
import { ROLE_ACTION_TEXT, roleActionFor, type RoleAction } from "../lib/memberRoles";
import { BotBadge, MemberAvatar } from "./MemberAvatar";
import { CrownIcon } from "./ui";

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
}: {
  members: Member[];
  onInvite?: () => void;
  roles?: MemberRoleControls;
  /** 改角色失败等提示 */
  notice?: string | null;
  onDismissNotice?: () => void;
}) {
  const order = { owner: 0, admin: 1, member: 2, bot: 3 } as const;
  const users = members.filter((m) => m.type === "user").sort((a, b) => order[a.role] - order[b.role]);
  const bots = members.filter((m) => m.type === "bot");
  return (
    <aside aria-label="成员列表" className="hidden w-60 shrink-0 overflow-y-auto bg-[#2b2d31] px-2 py-4 lg:block">
      {onInvite ? (
        <button
          type="button"
          onClick={onInvite}
          className="mb-4 w-full rounded px-2 py-1.5 text-left text-sm text-brand-light hover:bg-[#35373c] hover:text-white"
        >
          ＋ 邀请成员
        </button>
      ) : null}
      {notice ? (
        <div role="alert" className="mb-3 flex items-start gap-2 rounded-md bg-[#f23f43]/15 px-2.5 py-2 text-xs text-[#ff8a8c]">
          <span className="flex-1">{notice}</span>
          <button type="button" aria-label="关闭提示" className="text-[#ff8a8c] hover:text-white" onClick={onDismissNotice}>
            ✕
          </button>
        </div>
      ) : null}
      <Group title={`成员 — ${users.length}`} items={users} roles={roles} />
      <Group title={`Bot — ${bots.length}`} items={bots} />
    </aside>
  );
}

function Group({ title, items, roles }: { title: string; items: Member[]; roles?: MemberRoleControls }) {
  const [openId, setOpenId] = useState<string | null>(null);
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
                action
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
              {action && roles ? (
                // key=action：角色变化（乐观更新/推送）后换一个新的 Dropdown 实例，菜单项 id 保持稳定，
                // 避免 React Aria 在菜单退出动画期间报 "Cannot change the id of an item"
                <Dropdown key={action} isOpen={open} onOpenChange={(o) => setOpenId(o ? m.id : null)}>
                  <Dropdown.Trigger
                    aria-label={`${m.display_name} 的成员操作`}
                    isDisabled={roles.pendingId === m.id}
                    // 桌面端悬停/键盘聚焦才出现；触屏（无 hover 或粗指针）一直显示
                    data-testid="member-actions"
                    className={`ml-auto flex h-6 w-6 shrink-0 items-center justify-center rounded text-[#b5bac1] outline-none hover:bg-[#404249] hover:text-white focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-brand ${
                      open
                        ? "opacity-100"
                        : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100 [@media(hover:none)]:opacity-100"
                    }`}
                  >
                    ⋯
                  </Dropdown.Trigger>
                  {/* 贴着「⋯」向左弹出、与按钮垂直居中：菜单高度不超过一行，不压住上下相邻成员 */}
                  <Dropdown.Popover placement="left" offset={6} className="min-w-36">
                    <Dropdown.Menu className="p-1" aria-label={`${m.display_name} 的成员操作`} onAction={() => roles.onAction(m, action)}>
                      <Dropdown.Item id="toggle-role" className="min-h-8" textValue={ROLE_ACTION_TEXT[action]} variant={action === "demote" ? "danger" : "default"}>
                        {/* HeroUI 的 danger 变体只给 [data-slot=label] 上色，纯文本子节点会继承白字，所以必须包 Label */}
                        <Label className={action === "demote" ? "text-danger" : undefined}>{ROLE_ACTION_TEXT[action]}</Label>
                      </Dropdown.Item>
                    </Dropdown.Menu>
                  </Dropdown.Popover>
                </Dropdown>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
