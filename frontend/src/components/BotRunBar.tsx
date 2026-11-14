import { CloseButton } from "@heroui/react";
import type { Member } from "../api/types";
import { botRunText, isConnecting, isDismissable, typingText, type BotRun } from "../lib/botRuns";
import { MemberAvatar } from "./MemberAvatar";

/**
 * bot 运行状态区：放在消息列表和输入框之间（正常布局，不浮层）。
 * - 连接中（bot.run.started 或乐观状态：已触发、webhook 还没送达）：只显示「···」动画；
 * - 已送达（bot.run.delivered：webhook 返回 2xx）：合并成一行，bot 的程序化头像（多个并排，最多 3 个，不加边框）+「A 正在输入…」/「A 和 B 正在输入…」/「A、B 等 N 个正在输入…」；
 * - 重试中 / 失败 / 暂时没有回复 / 选择不回复：沿用原来的文案（后三者可关闭）。
 * 失败的技术原因（no_webhook 等）只给所有者/管理员看；普通成员看到“<bot名> 暂时无法响应”。
 */
export function BotRunBar({
  runs,
  members,
  showTechnicalReason,
  onDismiss,
}: {
  runs: BotRun[];
  members: Member[];
  showTechnicalReason: boolean;
  onDismiss(key: string): void;
}) {
  if (runs.length === 0) return null;
  const memberOf = (id: string) => members.find((m) => m.id === id);
  const nameOf = (id: string) => memberOf(id)?.display_name ?? "Bot";
  const dots = (
    <span className="flex gap-0.5" aria-hidden="true">
      <i className="teams-dot inline-block h-1.5 w-1.5 rounded-full bg-current" />
      <i className="teams-dot inline-block h-1.5 w-1.5 rounded-full bg-current" />
      <i className="teams-dot inline-block h-1.5 w-1.5 rounded-full bg-current" />
    </span>
  );
  const typing = runs.filter((r) => !isConnecting(r) && r.phase === "delivered");
  // 同一个 bot 多次触发只算一次
  const typingIds = [...new Set(typing.map((r) => r.bot_member_id))];
  const typingMembers = typingIds.map(memberOf).filter((m): m is Member => !!m);
  const typingLabel = typingText(typingIds.map(nameOf));
  return (
    <div className="flex shrink-0 flex-col gap-1 px-4 pb-1.5" aria-live="polite" data-testid="bot-run-bar">
      {runs.map((r) => {
        const text = botRunText(r, nameOf(r.bot_member_id), { technical: showTechnicalReason });
        if (isConnecting(r)) {
          return (
            <div key={r.key} data-phase={r.phase} data-stage="connecting" title={text} className="flex h-7 items-center px-3 text-[#b5bac1]">
              {dots}
              <span className="sr-only">{text}</span>
            </div>
          );
        }
        if (r.phase === "delivered") {
          // 所有正在输入的 bot 合并成一行，放在第一个 delivered 的位置
          if (r !== typing[0]) return null;
          return (
            <div key="typing" data-phase="delivered" data-stage="typing" title={typingLabel} className="flex h-7 min-w-0 items-center gap-2 px-3 text-xs text-[#b5bac1]">
              <span className="flex shrink-0 gap-1" aria-hidden="true">
                {typingMembers.slice(0, 3).map((m) => (
                  <MemberAvatar key={m.id} member={m} size={20} />
                ))}
              </span>
              <span className="min-w-0 truncate" data-testid="typing-text">
                {typingLabel}
              </span>
            </div>
          );
        }
        const bad = r.phase === "failed";
        const warn = r.phase === "timeout";
        const declined = r.phase === "declined";
        return (
          <div
            key={r.key}
            data-phase={r.phase}
            className={`flex items-center gap-2 rounded-md px-3 py-1.5 text-xs ${
              bad ? "bg-[#f23f43]/15 text-[#ff8a8c]" : warn ? "bg-[#f0b232]/15 text-[#f0b232]" : declined ? "bg-white/[0.04] text-[#949ba4]" : "text-[#b5bac1]"
            }`}
          >
            {bad || warn || declined ? <span aria-hidden="true">{bad ? "⚠" : warn ? "⏱" : "⊘"}</span> : dots}
            <span className="flex-1">{text}</span>
            {isDismissable(r) ? (
              <CloseButton aria-label="关闭提示" className="h-auto min-h-0 size-5 min-w-5 rounded bg-transparent hover:bg-transparent data-[hovered=true]:bg-transparent [&_svg]:size-3 text-current opacity-80 hover:opacity-100" onPress={() => onDismiss(r.key)} />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
