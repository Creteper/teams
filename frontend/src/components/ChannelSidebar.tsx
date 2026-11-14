import { useState } from "react";
import { Link } from "react-router";
import { Button, Input } from "@heroui/react";
import type { Channel, Team, User } from "../api/types";
import { MemberAvatar } from "./MemberAvatar";
import { GearIcon, MenuItem, PopMenu } from "./ui";
import { RowActionsMenu } from "./RowActionsMenu";
import { CHANNEL_ACTION_TEXT, channelActions, type ChannelAction } from "../lib/channels";

/** 第二栏：team 名 + 下拉菜单、频道列表（可新建）、底部自己 + 齿轮菜单 */
export function ChannelSidebar({
  team,
  channels,
  currentChannelId,
  me,
  canManage,
  onCreateChannel,
  onInvite,
  onSettings,
  onLeave,
  onLogout,
  onEditProfile,
  myMemberId = "",
  onChannelAction,
}: {
  team: Team | null;
  channels: Channel[];
  currentChannelId?: string;
  me: User;
  canManage: boolean;
  onCreateChannel(name: string): Promise<void>;
  onInvite(): void;
  onSettings(): void;
  onLeave(): void;
  onLogout(): void;
  onEditProfile(): void;
  myMemberId?: string;
  /** 频道菜单（改名 / 删除）；不传则不显示菜单 */
  onChannelAction?: (channel: Channel, action: ChannelAction) => void;
}) {
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [teamMenu, setTeamMenu] = useState(false);
  const [userMenu, setUserMenu] = useState(false);
  const isOwner = team?.my_role === "owner";

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
      <div className="relative">
        <button
          type="button"
          onClick={() => setTeamMenu((v) => !v)}
          aria-haspopup="menu"
          aria-expanded={teamMenu}
          className="flex h-12 w-full items-center justify-between border-b border-black/30 px-4 text-left font-semibold text-[#f2f3f5] hover:bg-[#35373c]"
        >
          <span className="truncate">{team?.name ?? "…"}</span>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true" className={`text-[#b5bac1] transition-transform ${teamMenu ? "rotate-180" : ""}`}>
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>
        <PopMenu open={teamMenu} onClose={() => setTeamMenu(false)} label="Team 菜单" className="absolute left-2 right-2 top-[52px]">
          {canManage ? (
            <MenuItem
              onSelect={() => {
                setTeamMenu(false);
                onInvite();
              }}
            >
              邀请成员 <span className="text-xs opacity-70">＋</span>
            </MenuItem>
          ) : null}
          {canManage ? (
            <MenuItem
              onSelect={() => {
                setTeamMenu(false);
                onSettings();
              }}
            >
              Team 设置 <span className="text-xs opacity-70">⚙</span>
            </MenuItem>
          ) : null}
          {canManage ? <div className="my-1 h-px bg-white/10" /> : null}
          <MenuItem
            danger
            disabled={isOwner}
            hint={isOwner ? "所有者不能退出 team" : undefined}
            onSelect={() => {
              setTeamMenu(false);
              onLeave();
            }}
          >
            退出 Team
          </MenuItem>
          {isOwner ? <p className="px-2 pb-1 text-[11px] leading-snug text-[#949ba4]">你是所有者，不能退出 team。</p> : null}
        </PopMenu>
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
              maxLength={64}
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
            // 没有权限的项不出现；一项都没有就不显示「⋯」和右键菜单
            const actions = onChannelAction ? channelActions(team?.my_role, myMemberId, c) : [];
            const open = menuFor === c.id;
            return (
              <li
                key={c.id}
                data-channel-id={c.id}
                data-default={c.is_default ? "true" : undefined}
                onContextMenu={
                  actions.length > 0
                    ? (e) => {
                        e.preventDefault();
                        setMenuFor(c.id);
                      }
                    : undefined
                }
                className={`group flex items-center rounded pr-1 ${
                  active ? "bg-[#404249] text-white" : open ? "bg-[#35373c] text-[#dbdee1]" : "text-[#949ba4] hover:bg-[#35373c] hover:text-[#dbdee1]"
                }`}
              >
                <Link
                  to={`/teams/${c.team_id}/channels/${c.id}`}
                  aria-current={active ? "page" : undefined}
                  className="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1.5 text-[15px] outline-none focus-visible:ring-2 focus-visible:ring-brand rounded"
                >
                  <span className="text-xl leading-none text-[#80848e]">#</span>
                  <span className="truncate">{c.name}</span>
                </Link>
                <RowActionsMenu
                  label={`频道 ${c.name} 的操作`}
                  placement="right"
                  actions={actions.map((a) => ({ id: a, text: CHANNEL_ACTION_TEXT[a], danger: a === "delete" }))}
                  open={open}
                  onOpenChange={(o) => setMenuFor(o ? c.id : null)}
                  onAction={(id) => onChannelAction?.(c, id as ChannelAction)}
                />
              </li>
            );
          })}
        </ul>
      </div>

      <div className="relative flex h-[52px] items-center gap-2 bg-[#232428] px-2">
        <button
          type="button"
          aria-label="编辑头像和个人资料"
          title="编辑头像和个人资料"
          onClick={onEditProfile}
          className="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-brand"
        >
          <MemberAvatar member={me} size={32} />
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-[#f2f3f5]">{me.display_name}</div>
          <div className="truncate text-xs text-[#b5bac1]">@{me.username}</div>
        </div>
        <button
          type="button"
          aria-label="用户设置"
          aria-haspopup="menu"
          aria-expanded={userMenu}
          onClick={() => setUserMenu((v) => !v)}
          className="flex h-8 w-8 items-center justify-center rounded text-[#b5bac1] hover:bg-[#35373c] hover:text-white"
        >
          <GearIcon />
        </button>
        <PopMenu open={userMenu} onClose={() => setUserMenu(false)} label="用户菜单" className="absolute bottom-[56px] left-2 right-2">
          <div className="px-2 py-1.5 text-xs text-[#949ba4]">已登录为 @{me.username}</div>
          <MenuItem
            onSelect={() => {
              setUserMenu(false);
              onEditProfile();
            }}
          >
            编辑个人资料
          </MenuItem>
          <div className="my-1 h-px bg-white/10" />
          <MenuItem
            danger
            onSelect={() => {
              setUserMenu(false);
              onLogout();
            }}
          >
            退出登录
          </MenuItem>
        </PopMenu>
      </div>
    </aside>
  );
}
