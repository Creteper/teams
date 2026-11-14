import type { Member } from "../api/types";
import { botRunText, isDismissable, type BotRun } from "../lib/botRuns";

/**
 * bot 处理状态区：放在消息列表和输入框之间（正常布局，不浮层），正在处理 / 正在重试 / 失败 / 暂时没有回复（后两者可关闭）。
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
  const nameOf = (id: string) => members.find((m) => m.id === id)?.display_name ?? "Bot";
  return (
    <div className="flex shrink-0 flex-col gap-1 px-4 pb-1.5" aria-live="polite" data-testid="bot-run-bar">
      {runs.map((r) => {
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
            {bad || warn || declined ? (
              <span aria-hidden="true">{bad ? "⚠" : warn ? "⏱" : "⊘"}</span>
            ) : (
              <span className="flex gap-0.5" aria-hidden="true">
                <i className="teams-dot inline-block h-1.5 w-1.5 rounded-full bg-current" />
                <i className="teams-dot inline-block h-1.5 w-1.5 rounded-full bg-current" />
                <i className="teams-dot inline-block h-1.5 w-1.5 rounded-full bg-current" />
              </span>
            )}
            <span className="flex-1">{botRunText(r, nameOf(r.bot_member_id), { technical: showTechnicalReason })}</span>
            {isDismissable(r) ? (
              <button type="button" aria-label="关闭提示" className="text-base leading-none opacity-80 hover:opacity-100" onClick={() => onDismiss(r.key)}>
                ×
              </button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
