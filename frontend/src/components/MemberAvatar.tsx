import { Avatar } from "@heroui/react";
import { avatarMode, type AvatarSource } from "../lib/avatar";
import { BotAvatar } from "./BotAvatar";

export function initials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "?";
  const words = trimmed.split(/\s+/);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return Array.from(trimmed).slice(0, 2).join("").toUpperCase();
}

const PALETTE = ["#6d5cf6", "#eb459e", "#23a55a", "#f0b232", "#e67e22", "#1abc9c", "#9b59b6"];
export function colorOf(seed: string): string {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

/** 统一头像组件：成员列表、消息、@ 候选、个人栏都用它 */
export function MemberAvatar({ member, size = 40 }: { member: AvatarSource & { member_id?: string; id?: string }; size?: number }) {
  const mode = avatarMode(member);
  if (mode === "procedural") {
    // 程序化 bot 头像（shape/color 由 BotAvatar 内部 trim + 忽略大小写解析，未知值回退默认）。
    // 深色界面：colorScheme="dark"（黑色身体画成白色）。不加外圈底色 / 描边 / ring，直接显示形状本身；
    // 外层只占位（保持与用户头像同样的尺寸和对齐）。
    return (
      <span className="inline-flex shrink-0 items-center justify-center" style={{ width: size, height: size }} data-avatar="bot">
        <BotAvatar
          shape={member.avatar_shape ?? ""}
          color={member.avatar_color ?? ""}
          seed={member.member_id ?? member.id}
          colorScheme="dark"
          size={size}
          title={member.display_name}
        />
      </span>
    );
  }
  return (
    <Avatar className="shrink-0" style={{ width: size, height: size }}>
      {/* object-fit: cover 居中裁成方形：非正方形图片（尤其是原样上传的 GIF 动图）不拉伸，动画照常播放 */}
      {mode === "image" ? <Avatar.Image src={member.avatar_url!} alt={member.display_name} className="object-cover object-center" /> : null}
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
    <span className="inline-flex h-[15px] items-center rounded-[3px] bg-brand px-1 text-[10px] font-semibold leading-none text-white">
      BOT
    </span>
  );
}
