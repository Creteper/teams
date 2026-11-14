import { ApiError } from "../api/errors";

/** 和其他地方保持一致的网络异常提示 */
export const NETWORK_ERROR_TEXT = "网络异常，请检查网络后重试";

const hasChinese = (s: string) => /[\u4e00-\u9fff]/.test(s);

/**
 * 给用户看的错误文案：只显示中文。
 * - 网络不通（fetch 抛 TypeError「Failed to fetch」等）→ NETWORK_ERROR_TEXT；
 * - 后端错误体里的 message 本来就是中文（apierr），原样显示；
 * - 浏览器 / 网关的英文原文（statusText、DOMException、TypeError 等）一律不展示，按状态码换成中文。
 */
export function errorText(e: unknown, fallback = "操作失败，请稍后再试"): string {
  if (e instanceof ApiError) {
    if (e.code === "network_error" || e.status === 0) return NETWORK_ERROR_TEXT;
    if (hasChinese(e.message)) return e.message;
    if (e.status === 413) return "文件太大";
    if (e.status === 429) return "操作太频繁了，请稍后再试";
    if (e.status >= 500) return `服务器暂时不可用，请稍后再试${e.requestId ? `（请求编号 ${e.requestId}）` : ""}`;
    return `${fallback}（错误码 ${e.code || e.status}）`;
  }
  if (e instanceof DOMException && e.name === "AbortError") return "已取消";
  if (e instanceof TypeError && /fetch|network|load failed/i.test(e.message)) return NETWORK_ERROR_TEXT;
  const msg = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  return msg && hasChinese(msg) ? msg : fallback;
}
