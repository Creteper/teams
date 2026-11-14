import { Avatar } from "@heroui/react";
import { avatarMode, type AvatarSource } from "../lib/avatar";

export function initials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "?";
  const words = trimmed.split(/\s+/);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return Array.from(trimmed).slice(0, 2).join("").toUpperCase();
}

const PALETTE = ["#5865f2", "#eb459e", "#23a55a", "#f0b232", "#e67e22", "#1abc9c", "#9b59b6"];
export function colorOf(seed: string): string {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

/** 统一头像组件：成员列表、消息、@ 候选、个人栏都用它 */
export function MemberAvatar({ member, size = 40 }: { member: AvatarSource; size?: number }) {
  const mode = avatarMode(member);
  if (mode === "procedural") {
    // TODO: 替换为 BotAvatar（程序化 bot 头像组件，另行实现）；这里先按 avatar_color 填色的圆占位
    return (
      <span
        role="img"
        aria-label={member.display_name}
        data-avatar-shape={member.avatar_shape ?? undefined}
        className="inline-block shrink-0 rounded-full ring-1 ring-white/20"
        style={{ width: size, height: size, backgroundColor: member.avatar_color ?? "#5865f2" }}
      />
    );
  }
  return (
    <Avatar className="shrink-0" style={{ width: size, height: size }}>
      {mode === "image" ? <Avatar.Image src={member.avatar_url!} alt={member.display_name} /> : null}
      <Avatar.Fallback
        className="font-semibold text-white"
        style={{ backgroundColor: colorOf(member.display_name), fontSize: Math.max(11, Math.round(size * 0.38)) }}
      >
        {initials(member.display_name)}
      </Avatar.Fallback>
    </Avatar>
  );
}

export function BotBadge() {
  return (
    <span className="inline-flex h-[15px] items-center rounded-[3px] bg-[#5865f2] px-1 text-[10px] font-semibold leading-none text-white">
      BOT
    </span>
  );
}
