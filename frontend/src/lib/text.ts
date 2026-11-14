/** 按 Unicode 字符计数（与后端一致：[...str].length） */
export const charCount = (s: string) => [...s].length;

export const TEAM_NAME_MAX = 50;
export const TEAM_DESC_MAX = 500;

/** team 名称/简介校验（首尾空白去掉后计数），返回错误文案或 null */
export function validateTeamFields(name: string, description: string): string | null {
  const n = charCount(name.trim());
  if (n < 1) return "名称不能为空";
  if (n > TEAM_NAME_MAX) return `名称最多 ${TEAM_NAME_MAX} 个字`;
  if (charCount(description.trim()) > TEAM_DESC_MAX) return `简介最多 ${TEAM_DESC_MAX} 个字`;
  return null;
}

/** 从邀请链接或邀请码里取出 code：支持完整 URL、/invite/xxx 路径和纯 code */
export function parseInviteInput(raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  const m = /\/invite\/([A-Za-z0-9_-]+)/.exec(v);
  if (m) return m[1];
  return /^[A-Za-z0-9_-]{4,64}$/.test(v) ? v : null;
}
