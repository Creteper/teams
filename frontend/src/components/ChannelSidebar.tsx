import { useState } from "react";
import { Link } from "react-router";
import { Button, Input } from "@heroui/react";
import type { Channel, Team, User } from "../api/types";
import { MemberAvatar } from "./MemberAvatar";

/** 第二栏：team 名 + 频道列表（可新建）+ 底部自己 */
export function ChannelSidebar({
  team,
  channels,
  currentChannelId,
  me,
  onCreateChannel,
  onLogout,
}: {
  team: Team | null;
  channels: Channel[];
  currentChannelId?: string;
  me: User;
  onCreateChannel(name: string): Promise<void>;
  onLogout(): void;
}) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    try {
      await onCreateChannel(name);
      setName("");
      setCreating(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <aside className="flex w-60 shrink-0 flex-col bg-[#2b2d31]">
      <div
        className="flex h-12 items-center justify-between border-b border-black/30 px-4 font-semibold text-[#f2f3f5]"
        title={team?.description || team?.name}
      >
        <span className="truncate">{team?.name ?? "…"}</span>
        {team ? <span className="text-xs font-normal text-[#949ba4]">{team.my_role}</span> : null}
      </div>

      <div className="flex-1 overflow-y-auto px-2 pt-4">
        <div className="mb-1 flex items-center justify-between px-1 text-xs font-semibold uppercase tracking-wide text-[#949ba4]">
          <span>文字频道</span>
          <button
            type="button"
            aria-label="新建频道"
            title="新建频道"
            onClick={() => setCreating((v) => !v)}
            className="text-lg leading-none text-[#b5bac1] hover:text-white"
          >
            +
          </button>
        </div>
        {creating ? (
          <div className="mb-2 flex flex-col gap-2 rounded bg-[#1e1f22] p-2">
            <Input
              aria-label="频道名"
              placeholder="新频道名"
              value={name}
              autoFocus
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void submit();
              }}
            />
            {error ? <p className="text-xs text-[#f23f43]">{error}</p> : null}
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onPress={() => setCreating(false)}>
                取消
              </Button>
              <Button size="sm" variant="primary" onPress={() => void submit()}>
                创建
              </Button>
            </div>
          </div>
        ) : null}
        <ul className="flex flex-col gap-0.5">
          {channels.map((c) => {
            const active = c.id === currentChannelId;
            return (
              <li key={c.id}>
                <Link
                  to={`/teams/${c.team_id}/channels/${c.id}`}
                  className={`flex items-center gap-1.5 rounded px-2 py-1.5 text-[15px] ${
                    active ? "bg-[#404249] text-white" : "text-[#949ba4] hover:bg-[#35373c] hover:text-[#dbdee1]"
                  }`}
                >
                  <span className="text-xl leading-none text-[#80848e]">#</span>
                  <span className="truncate">{c.name}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="flex h-[52px] items-center gap-2 bg-[#232428] px-2">
        <MemberAvatar member={me} size={32} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-[#f2f3f5]">{me.display_name}</div>
          <div className="truncate text-xs text-[#b5bac1]">@{me.username}</div>
        </div>
        <button
          type="button"
          onClick={onLogout}
          className="rounded px-2 py-1 text-xs text-[#b5bac1] hover:bg-[#35373c] hover:text-white"
        >
          退出
        </button>
      </div>
    </aside>
  );
}
