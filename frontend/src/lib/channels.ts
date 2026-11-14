import { ApiError } from "../api/errors";
import type { Channel } from "../api/types";
import { charCount } from "./text";

/** 频道菜单项 id。置顶（pin）先留位置：后端还没有接口，PIN_ENABLED=false 时不显示 */
export type ChannelAction = "rename" | "delete" | "pin";
export const PIN_ENABLED = false;

/**
 * docs/api.md §5.1：
 * - 改名 PATCH /channels/{id}：owner/admin/创建者
 * - 删除 DELETE /channels/{id}：owner/admin；默认频道不能删（403）
 * 没有任何项时调用方不显示菜单。
 */
export function channelActions(myRole: string | null | undefined, myMemberId: string, channel: Channel): ChannelAction[] {
  const manager = myRole === "owner" || myRole === "admin";
  const out: ChannelAction[] = [];
  if (manager || (!!myMemberId && channel.created_by_member_id === myMemberId)) out.push("rename");
  if (PIN_ENABLED) out.push("pin");
  if (manager && !channel.is_default) out.push("delete");
  return out;
}

export const CHANNEL_ACTION_TEXT: Record<ChannelAction, string> = { rename: "改名", delete: "删除频道", pin: "置顶" };

export const CHANNEL_NAME_MAX = 64;

/** 频道名：去首尾空白后 1–64 字符；同 team 不区分大小写唯一（本地先查一遍，服务端 409 兜底） */
export function channelNameError(name: string, channels: Channel[], selfId?: string): string | null {
  const n = name.trim();
  const len = charCount(n);
  if (len < 1) return "频道名不能为空";
  if (len > CHANNEL_NAME_MAX) return `频道名最多 ${CHANNEL_NAME_MAX} 个字符`;
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
    if (err.status === 400) return `${what}：${err.message}`;
    if (err.code === "rate_limited") return `${what}：${err.message}`;
    return `${what}：${err.message}${err.requestId ? `（请求编号 ${err.requestId}）` : ""}`;
  }
  return `${what}：网络异常，请稍后再试`;
}
