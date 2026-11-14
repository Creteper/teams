import { ApiError } from "../api/errors";

/** 文件大小：12994 → 「12.7 KB」 */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** install_path（.cursor/skills/teams-bot-integration/SKILL.md）→ 默认安装目录 ./.cursor/skills/teams-bot-integration/ */
export function installDir(installPath: string | undefined): string {
  const fallback = "./.cursor/skills/teams-bot-integration/";
  if (!installPath) return fallback;
  const dir = installPath.replace(/\/?SKILL\.md$/i, "").replace(/^\.?\//, "");
  return dir ? `./${dir}/` : fallback;
}

/** GET /skill 失败时给用户看的话 */
export function skillErrorText(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === "skill_unavailable") return "Skill 包暂时不可用（服务器端安装包异常），请稍后再试或联系管理员。";
    if (e.code === "network_error") return "网络错误，无法获取 Skill 信息，请检查网络后重试。";
    return `获取 Skill 信息失败：${e.message}`;
  }
  return `获取 Skill 信息失败：${e instanceof Error ? e.message : String(e)}`;
}
