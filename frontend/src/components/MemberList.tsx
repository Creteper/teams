import type { Member } from "../api/types";
import { roleLabel } from "../lib/roles";
import { BotBadge, MemberAvatar } from "./MemberAvatar";
import { CrownIcon } from "./ui";

/**
 * 右侧成员列表：按“成员 / Bot”分组；所有者带皇冠，管理员名字用另一种颜色；bot 带 BOT 标记。
 * 所有者/管理员才显示“邀请成员”。
 */
export function MemberList({ members, onInvite }: { members: Member[]; onInvite?: () => void }) {
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
      <Group title={`成员 — ${users.length}`} items={users} />
      <Group title={`Bot — ${bots.length}`} items={bots} />
    </aside>
  );
}

function Group({ title, items }: { title: string; items: Member[] }) {
  if (items.length === 0) return null;
  return (
    <section className="mb-5">
      <h3 className="mb-1 px-2 text-xs font-semibold uppercase tracking-wide text-[#949ba4]">{title}</h3>
      <ul>
        {items.map((m) => (
          <li
            key={m.id}
            data-type={m.type}
            data-role={m.role}
            title={`@${m.username}${m.type === "user" ? ` · ${roleLabel(m.role)}` : ""}`}
            className="flex items-center gap-3 rounded px-2 py-1.5 hover:bg-[#35373c]"
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
          </li>
        ))}
      </ul>
    </section>
  );
}
