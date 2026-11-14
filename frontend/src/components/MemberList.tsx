import type { Member } from "../api/types";
import { BotBadge, MemberAvatar } from "./MemberAvatar";

/**
 * 右侧成员列表：按“成员 / Bot”分组，bot 名字旁带 BOT 标记（文档无在线状态，不显示）。
 * owner/admin 显示“邀请成员”（弹窗内含邀请链接和按用户名添加）。
 */
export function MemberList({ members, onInvite }: { members: Member[]; onInvite?: () => void }) {
  const users = members.filter((m) => m.type === "user");
  const bots = members.filter((m) => m.type === "bot");
  return (
    <aside aria-label="成员列表" className="hidden w-60 shrink-0 overflow-y-auto bg-[#2b2d31] px-2 py-4 lg:block">
      {onInvite ? (
        <button
          type="button"
          onClick={onInvite}
          className="mb-4 w-full rounded px-2 py-1.5 text-left text-sm text-[#b5bac1] hover:bg-[#35373c] hover:text-white"
        >
          ＋ 邀请成员
        </button>
      ) : null}
      <Group title={`成员 — ${users.length}`} items={users} />
      <Group title={`Bot — ${bots.length}`} items={bots} />
    </aside>
  );
}

const ROLE_LABEL: Record<string, string> = { owner: "所有者", admin: "管理员" };

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
            title={`@${m.username}`}
            className="flex items-center gap-3 rounded px-2 py-1.5 hover:bg-[#35373c]"
          >
            <MemberAvatar member={m} size={32} />
            <span className="truncate text-[15px] text-[#dbdee1]">{m.display_name}</span>
            {m.type === "bot" ? <BotBadge /> : null}
            {ROLE_LABEL[m.role] ? <span className="text-[11px] text-[#f0b232]">{ROLE_LABEL[m.role]}</span> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
