export interface AvatarSource {
  display_name: string;
  avatar_url?: string | null;
  avatar_shape?: string | null;
  avatar_color?: string | null;
}

export type AvatarMode = "procedural" | "image" | "initials";

/** 头像渲染优先级：avatar_shape/avatar_color → avatar_url → 首字母 */
export function avatarMode(src: AvatarSource): AvatarMode {
  if (src.avatar_shape || src.avatar_color) return "procedural";
  if (src.avatar_url) return "image";
  return "initials";
}
