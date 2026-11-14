import { useEffect, useState } from "react";
import { Spinner } from "@heroui/react";
import { api } from "../api";
import type { Member } from "../api/types";
import { roleLabel } from "../lib/roles";
import { BotBadge, MemberAvatar } from "./MemberAvatar";
import { CrownIcon, DialogShell } from "./ui";

/** 加入时间：本地时区的“yyyy年M月d日 HH:mm” */
export function formatJoinedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("zh-CN", { year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
}

/**
 * 成员资料卡：头像、显示名、用户名、角色、加入时间（都来自 Member，§3）；
 * bot 另外显示描述——Member 里没有 description，按 member.bot_id 调 GET /bots/{bot_id}（§8.1，成员可读）。
 */
export function MemberProfileDialog({ token, member, isMe, onClose }: { token: string; member: Member; isMe: boolean; onClose(): void }) {
  const isBot = member.type === "bot";
  const [desc, setDesc] = useState<{ loading: boolean; text: string | null; error: string | null }>({
    loading: isBot && !!member.bot_id,
    text: null,
    error: null,
  });

  useEffect(() => {
    if (!isBot || !member.bot_id) return;
    let cancelled = false;
    api
      .getBot(token, member.bot_id)
      .then((b) => !cancelled && setDesc({ loading: false, text: b.description, error: null }))
      .catch((e: unknown) => !cancelled && setDesc({ loading: false, text: null, error: e instanceof Error ? e.message : String(e) }));
    return () => {
      cancelled = true;
    };
  }, [token, isBot, member.bot_id]);

  return (
    <DialogShell label="成员资料" title="成员资料" onClose={onClose} width="max-w-sm">
      <div className="flex flex-col items-center gap-3 text-center" data-testid="member-profile" data-member-id={member.id}>
        <MemberAvatar member={member} size={88} />
        <div>
          <div className="flex items-center justify-center gap-1.5 text-lg font-bold text-white">
            <span className="truncate">{member.display_name}</span>
            {member.role === "owner" ? <CrownIcon size={16} /> : null}
            {isBot ? <BotBadge /> : null}
          </div>
          <div className="text-sm text-[#b5bac1]">
            @{member.username}
            {isMe ? <span className="ml-1 text-xs text-[#949ba4]">（你）</span> : null}
          </div>
        </div>
      </div>
      <dl className="mt-5 grid grid-cols-[5rem_1fr] gap-x-3 gap-y-2 rounded-lg bg-[#2b2d31] p-4 text-sm">
        <dt className="text-[#949ba4]">角色</dt>
        <dd className="text-[#dbdee1]" data-field="role">
          {roleLabel(member.role)}
        </dd>
        <dt className="text-[#949ba4]">加入时间</dt>
        <dd className="text-[#dbdee1]" data-field="joined_at">
          {formatJoinedAt(member.joined_at)}
        </dd>
        {isBot ? (
          <>
            <dt className="text-[#949ba4]">描述</dt>
            <dd className="whitespace-pre-wrap break-words text-[#dbdee1]" data-field="description">
              {desc.loading ? (
                <Spinner size="sm" aria-label="加载描述" />
              ) : desc.error ? (
                <span className="text-[#f23f43]">描述加载失败：{desc.error}</span>
              ) : desc.text ? (
                desc.text
              ) : (
                <span className="text-[#949ba4]">暂无描述</span>
              )}
            </dd>
          </>
        ) : null}
      </dl>
    </DialogShell>
  );
}
