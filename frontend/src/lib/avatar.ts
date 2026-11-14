export interface AvatarSource {
  display_name: string;
  avatar_url?: string | null;
  avatar_shape?: string | null;
  avatar_color?: string | null;
}

export type AvatarMode = "procedural" | "image" | "initials";

const present = (v: string | null | undefined) => typeof v === "string" && v.trim() !== "";

/**
 * 头像渲染优先级：avatar_shape/avatar_color（非空白）→ avatar_url → 首字母。
 * shape/color 原样存储、不保证小写，具体解析（trim + 忽略大小写 + 别名/回退）由 BotAvatar 的 resolve 完成。
 */
export function avatarMode(src: AvatarSource): AvatarMode {
  if (present(src.avatar_shape) || present(src.avatar_color)) return "procedural";
  if (src.avatar_url) return "image";
  return "initials";
}
