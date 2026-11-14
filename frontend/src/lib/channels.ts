import { errorText } from "./errorText";
import { ApiError } from "../api/errors";
import type { Channel } from "../api/types";
import { charCount } from "./text";

/** 频道菜单项 id。置顶 / 取消置顶按用户记录（§5.7 PUT/DELETE /channels/{id}/pin），所有用户成员都能用 */
export type ChannelAction = "pin" | "unpin" | "rename" | "delete";
export const PIN_ENABLED = true;

/**
 * docs/api.md §5.1：
 * - 改名 PATCH /channels/{id}：owner/admin/创建者
 * - 删除 DELETE /channels/{id}：owner/admin；默认频道不能删（403）
 * - 置顶 PUT/DELETE /channels/{id}/pin：用户会话（任何成员，bot 403）；pinned 为本人当前状态
 * 没有任何项时调用方不显示菜单。
 */
export function channelActions(myRole: string | null | undefined, myMemberId: string, channel: Channel, pinned = !!channel.pinned): ChannelAction[] {
  const manager = myRole === "owner" || myRole === "admin";
  const out: ChannelAction[] = [];
  if (PIN_ENABLED && myRole && myRole !== "bot") out.push(pinned ? "unpin" : "pin");
  if (manager || (!!myMemberId && channel.created_by_member_id === myMemberId)) out.push("rename");
  if (manager && !channel.is_default) out.push("delete");
  return out;
}

export const CHANNEL_ACTION_TEXT: Record<ChannelAction, string> = { pin: "置顶", unpin: "取消置顶", rename: "改名", delete: "删除频道" };

export const CHANNEL_NAME_MAX = 64;

/** 控制字符（换行、制表符等）：后端唯一禁止的字符类别（§5.1 名称规则） */
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * 频道名（§5.1）：去首尾空白后 1–64 个 Unicode 字符；只禁止控制字符；同 team 不区分大小写唯一（本地先查一遍，服务端 409 兜底）。
 * 不比后端更严：中文、空格、#、emoji、标点都允许。
 */
export function channelNameError(name: string, channels: Channel[], selfId?: string): string | null {
  const n = name.trim();
  const len = charCount(n);
  if (len < 1) return "频道名不能为空";
  if (CONTROL_RE.test(n)) return "频道名不能包含换行、制表符等控制字符";
  if (len > CHANNEL_NAME_MAX) return `频道名不能超过 ${CHANNEL_NAME_MAX} 个字`;
  if (channels.some((c) => c.id !== selfId && c.name.toLowerCase() === n.toLowerCase())) return "已有同名频道";
  return null;
}

/** 默认频道：优先 is_default，兜底名为 general，再兜底第一个 */
export function defaultChannel(channels: Channel[]): Channel | undefined {
  return channels.find((c) => c.is_default) ?? channels.find((c) => c.name === "general") ?? channels[0];
}

/** 频道操作失败的中文提示 */
export function channelErrorText(err: unknown, action: "rename" | "delete"): string {
  const what = action === "rename" ? "改名失败" : "删除频道失败";
  if (err instanceof ApiError) {
    if (err.status === 0) return `${what}：网络异常，请稍后再试`;
    if (err.status === 409) return `${what}：已有同名频道`;
    if (err.status === 403) return action === "delete" ? `${what}：你没有权限删除这个频道（默认频道不能删除）` : `${what}：你没有权限修改这个频道`;
    if (err.status === 404) return `${what}：频道不存在或已被删除`;
    if (err.status === 400) return `${what}：${errorText(err)}`;
    if (err.code === "rate_limited") return `${what}：${errorText(err)}`;
    return `${what}：${errorText(err)}${err.requestId && !errorText(err).includes(err.requestId) ? `（请求编号 ${err.requestId}）` : ""}`;
  }
  return `${what}：网络异常，请稍后再试`;
}
