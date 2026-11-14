import type { Member } from "../api/types";
import { botRunText, isDismissable, type BotRun } from "../lib/botRuns";

/** 输入框上方的 bot 处理状态条：正在处理 / 正在重试 / 失败 / 暂时没有回复（后两者可关闭） */
export function BotRunBar({ runs, members, onDismiss }: { runs: BotRun[]; members: Member[]; onDismiss(key: string): void }) {
  if (runs.length === 0) return null;
  const nameOf = (id: string) => members.find((m) => m.id === id)?.display_name ?? "Bot";
  return (
    <div className="mb-1 flex flex-col gap-1" aria-live="polite">
      {runs.map((r) => {
        const bad = r.phase === "failed";
        const warn = r.phase === "timeout";
        return (
          <div
            key={r.key}
            data-phase={r.phase}
            className={`flex items-center gap-2 rounded-md px-3 py-1.5 text-xs ${
              bad ? "bg-[#f23f43]/15 text-[#ff8a8c]" : warn ? "bg-[#f0b232]/15 text-[#f0b232]" : "text-[#b5bac1]"
            }`}
          >
            {bad || warn ? (
              <span aria-hidden="true">{bad ? "⚠" : "⏱"}</span>
            ) : (
              <span className="flex gap-0.5" aria-hidden="true">
                <i className="teams-dot inline-block h-1.5 w-1.5 rounded-full bg-current" />
                <i className="teams-dot inline-block h-1.5 w-1.5 rounded-full bg-current" />
                <i className="teams-dot inline-block h-1.5 w-1.5 rounded-full bg-current" />
              </span>
            )}
            <span className="flex-1">{botRunText(r, nameOf(r.bot_member_id))}</span>
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
