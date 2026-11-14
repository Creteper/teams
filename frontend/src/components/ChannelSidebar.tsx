import { errorText } from "../lib/errorText";
import { useState } from "react";
import { Link } from "react-router";
import { Button, Description, Dropdown, Input, Label, Separator, Tooltip } from "@heroui/react";
import type { Channel, Team, User } from "../api/types";
import { MemberAvatar } from "./MemberAvatar";
import { GearIcon, PinIcon, SlidersIcon } from "./ui";
import { RowActionsMenu } from "./RowActionsMenu";
import { CHANNEL_ACTION_TEXT, channelActions, type ChannelAction } from "../lib/channels";
import { sortChannels, unreadLabel, type UnreadMap } from "../lib/unread";
import { UnreadBadge } from "./UnreadBadge";

// team 菜单 / 用户菜单（HeroUI Dropdown）：保持原来的 Discord 深色紧凑样式，危险项红字、悬停红底白字
const MENU_POPOVER = "w-56 rounded-md bg-[#111214] p-1.5 shadow-xl ring-1 ring-black/50";
const MENU_SECTION = "p-0";
const MENU_ITEM =
  "min-h-8 rounded px-2 py-1.5 text-sm text-[#dbdee1] data-[hovered=true]:bg-brand data-[hovered=true]:text-white data-[focused=true]:bg-brand data-[focused=true]:text-white [&_[data-slot=label]]:text-inherit [&_[data-slot=label]]:font-normal";
const MENU_ITEM_DANGER =
  "min-h-8 rounded px-2 py-1.5 text-sm data-[hovered=true]:bg-[#f23f43] data-[focused=true]:bg-[#f23f43] data-[hovered=true]:[&_[data-slot=label]]:text-white data-[focused=true]:[&_[data-slot=label]]:text-white data-[disabled=true]:opacity-100 data-[disabled=true]:[&_[data-slot=label]]:opacity-40 [&_[data-slot=label]]:font-normal";

const HINT_TOOLTIP = "pointer-events-none rounded-md bg-[#111214] px-2.5 py-1.5 text-xs font-semibold text-white shadow-lg";

/**
 * 第二栏：team 名 + 下拉菜单、频道列表（可新建）、底部用户栏。
 * 用户栏照 Discord：点头像 → 设置里的「个人资料」；点齿轮 → 直接打开设置窗口（退出登录在设置左侧导航底部）。
 */
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
  onOpenSettings,
  myMemberId = "",
  onChannelAction,
  unread = {},
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
  /** 打开用户设置：头像 → "profile"；齿轮 → 不指定（宽屏默认个人资料，窄屏先显示分类列表） */
  onOpenSettings(tab?: "profile"): void;
  myMemberId?: string;
  /** 频道菜单（改名 / 删除）；不传则不显示菜单 */
  onChannelAction?: (channel: Channel, action: ChannelAction) => void;
  /** 本人的未读 / 置顶状态（§5.7），按 channel_id */
  unread?: UnreadMap;
}) {
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [teamMenu, setTeamMenu] = useState(false);
  const isOwner = team?.my_role === "owner";

  async function submit() {
    setError(null);
    try {
      await onCreateChannel(name);
      setName("");
      setCreating(false);
    } catch (e) {
      setError(errorText(e));
    }
  }

  // 置顶的按 pinned_at 排到最前面（后端顺序不变，§5.7），单独一组
  const { pinned, others } = sortChannels(channels, unread);
  const renderRow = (c: Channel) => {
    const active = c.id === currentChannelId;
    const st = unread[c.id];
    const isPinned = !!st?.pinned;
    // 正在看的频道不显示未读
    const count = active ? 0 : (st?.unread_count ?? 0);
    const mention = !active && !!st?.has_unread_mention;
    const hasUnread = count > 0 || mention;
    // 没有权限的项不出现；一项都没有就不显示「⋯」和右键菜单
    const actions = onChannelAction ? channelActions(team?.my_role, myMemberId, c, isPinned) : [];
    const open = menuFor === c.id;
    const label = unreadLabel(count);
    return (
      <li
        key={c.id}
        data-channel-id={c.id}
        data-default={c.is_default ? "true" : undefined}
        data-pinned={isPinned ? "true" : undefined}
        data-unread={hasUnread ? (mention ? "mention" : "true") : undefined}
        onContextMenu={
          actions.length > 0
            ? (e) => {
                e.preventDefault();
                setMenuFor(c.id);
              }
            : undefined
        }
        className={`group relative flex items-center rounded pr-1 ${
          active
            ? "bg-[#404249] text-white"
            : open
              ? "bg-[#35373c] text-[#dbdee1]"
              : hasUnread
                ? "text-[#f2f3f5] hover:bg-[#35373c]"
                : "text-[#949ba4] hover:bg-[#35373c] hover:text-[#dbdee1]"
        }`}
      >
        {hasUnread ? <span aria-hidden="true" className="absolute -left-2 top-1/2 h-2 w-1 -translate-y-1/2 rounded-r bg-white" /> : null}
        <Link
          to={`/teams/${c.team_id}/channels/${c.id}`}
          aria-current={active ? "page" : undefined}
          aria-label={`${c.name}${isPinned ? "（已置顶）" : ""}${mention ? `，有人 @ 你，${label ?? ""} 条未读` : label ? `，${label} 条未读` : ""}`}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded px-2 py-1.5 text-[15px] outline-none focus-visible:ring-2 focus-visible:ring-brand"
        >
          <span className="text-xl leading-none text-[#80848e]">#</span>
          <span className={`truncate ${hasUnread ? "font-semibold" : ""}`}>{c.name}</span>
        </Link>
        {hasUnread ? <UnreadBadge count={count} mention={mention} /> : null}
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
  };

  return (
    <aside className="flex w-60 shrink-0 flex-col bg-[#2b2d31]">
      <Dropdown isOpen={teamMenu} onOpenChange={setTeamMenu}>
        <Dropdown.Trigger
          aria-label={`${team?.name ?? "Team"} 菜单`}
          data-testid="team-name-trigger"
          // 左内边距 12px：team 名和下面「置顶 / 文字频道」分组标题的左边缘对齐（原来 16px，往右偏了 4px）
          className="flex h-12 w-full items-center justify-between rounded-none border-b border-black/30 pr-4 pl-3 text-left font-semibold text-[#f2f3f5] outline-none hover:bg-[#35373c] focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-inset"
        >
          <span className="truncate">{team?.name ?? "…"}</span>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true" className={`text-[#b5bac1] transition-transform ${teamMenu ? "rotate-180" : ""}`}>
            <path d="M6 9l6 6 6-6" />
          </svg>
        </Dropdown.Trigger>
        <Dropdown.Popover placement="bottom" offset={4} className={MENU_POPOVER}>
          <Dropdown.Menu
            aria-label="Team 菜单"
            className="p-0"
            disabledKeys={isOwner ? ["leave"] : []}
            onAction={(k) => {
              setTeamMenu(false);
              if (k === "invite") onInvite();
              else if (k === "settings") onSettings();
              else if (k === "leave") onLeave();
            }}
          >
            {canManage ? (
              <Dropdown.Section className={MENU_SECTION}>
                <Dropdown.Item id="invite" textValue="邀请成员" className={MENU_ITEM}>
                  <Label className="flex-1">邀请成员</Label>
                  <span className="text-xs opacity-70">＋</span>
                </Dropdown.Item>
                <Dropdown.Item id="settings" textValue="Team 设置" className={MENU_ITEM}>
                  <Label className="flex-1">Team 设置</Label>
                  {/* 不用齿轮：齿轮只代表用户设置，避免两个长得一样的图标功能不同 */}
                  <SlidersIcon size={14} className="opacity-70" />
                </Dropdown.Item>
              </Dropdown.Section>
            ) : null}
            {canManage ? <Separator className="my-1 bg-white/10" /> : null}
            <Dropdown.Section className={MENU_SECTION}>
              <Dropdown.Item id="leave" textValue="退出 Team" variant="danger" className={MENU_ITEM_DANGER}>
                <div className="flex flex-col">
                  <Label className="text-danger">退出 Team</Label>
                  {isOwner ? <Description className="text-[11px] leading-snug text-[#949ba4]">你是所有者，不能退出 team。</Description> : null}
                </div>
              </Dropdown.Item>
            </Dropdown.Section>
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown>

      <div className="flex-1 overflow-y-auto px-2 pt-4">
        {pinned.length > 0 ? (
          <>
            <div className="mb-1 flex items-center gap-1 px-1 text-xs font-semibold uppercase tracking-wide text-[#949ba4]" data-testid="pinned-heading">
              <PinIcon size={12} />
              <span>置顶</span>
            </div>
            <ul className="mb-3 flex flex-col gap-0.5" aria-label="置顶频道" data-testid="pinned-list">
              {pinned.map(renderRow)}
            </ul>
          </>
        ) : null}
        <div className="mb-1 flex items-center justify-between px-1 text-xs font-semibold uppercase tracking-wide text-[#949ba4]">
          <span>文字频道</span>
          <Tooltip delay={300}>
            <Button
              isIconOnly
              variant="ghost"
              aria-label="新建频道"
              onPress={() => setCreating((v) => !v)}
              className="size-5 min-h-0 min-w-5 rounded bg-transparent text-lg leading-none font-normal text-[#b5bac1] hover:bg-transparent hover:text-white data-[hovered=true]:bg-transparent"
            >
              +
            </Button>
            <Tooltip.Content className={HINT_TOOLTIP}>新建频道</Tooltip.Content>
          </Tooltip>
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
        <ul className="flex flex-col gap-0.5" aria-label="文字频道">
          {others.map(renderRow)}
        </ul>
      </div>

      <div className="relative flex h-[52px] items-center gap-2 bg-[#232428] px-2">
        <Tooltip delay={300}>
          <Button
            isIconOnly
            variant="ghost"
            aria-label="个人资料"
            data-testid="userbar-avatar"
            onPress={() => onOpenSettings("profile")}
            className="size-8 min-w-8 rounded-full bg-transparent p-0 outline-none hover:bg-transparent focus-visible:ring-2 focus-visible:ring-brand data-[hovered=true]:bg-transparent"
          >
            <MemberAvatar member={me} size={32} />
          </Button>
          <Tooltip.Content className={HINT_TOOLTIP}>个人资料</Tooltip.Content>
        </Tooltip>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-[#f2f3f5]">{me.display_name}</div>
          <div className="truncate text-xs text-[#b5bac1]">@{me.username}</div>
        </div>
        <Tooltip delay={300}>
          <Button
            isIconOnly
            variant="ghost"
            aria-label="用户设置"
            data-testid="userbar-settings"
            onPress={() => onOpenSettings()}
            className="size-8 min-w-8 rounded bg-transparent p-0 text-[#b5bac1] outline-none hover:bg-[#35373c] hover:text-white focus-visible:ring-2 focus-visible:ring-brand data-[hovered=true]:bg-[#35373c] data-[pressed=true]:bg-[#3f4147]"
          >
            <GearIcon />
          </Button>
          <Tooltip.Content className={HINT_TOOLTIP}>用户设置</Tooltip.Content>
        </Tooltip>
      </div>
    </aside>
  );
}
