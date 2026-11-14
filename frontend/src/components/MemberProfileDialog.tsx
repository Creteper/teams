import { errorText } from "../lib/errorText";
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
 * 成员资料卡（§3）：打开时调 GET /teams/{team_id}/members/{member_id} 拿最新资料；
 * 头像、显示名、用户名、角色、加入时间；bot 另外显示 description（用户成员恒为 null，不显示）。
 * 请求返回前先用列表里的 Member 渲染；已退出 / 已删除的成员显示“已退出”。
 */
export function MemberProfileDialog({ token, member: listed, isMe, onClose }: { token: string; member: Member; isMe: boolean; onClose(): void }) {
  const [fresh, setFresh] = useState<Member | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const member = fresh ?? listed;
  const isBot = member.type === "bot";

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .getMember(token, listed.team_id, listed.id)
      .then((m) => {
        if (cancelled) return;
        setFresh(m);
        setError(null);
      })
      .catch((e: unknown) => !cancelled && setError(errorText(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [token, listed.team_id, listed.id]);

  const description = member.description ?? null;

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
            {member.deleted ? <span className="ml-1 text-xs text-[#949ba4]">（已退出）</span> : null}
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
              {loading && !description ? (
                <Spinner size="sm" aria-label="加载描述" />
              ) : error && !description ? (
                <span className="text-[#f23f43]">资料加载失败：{error}</span>
              ) : description ? (
                description
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
