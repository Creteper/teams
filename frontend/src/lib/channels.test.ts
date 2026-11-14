import { describe, expect, it } from "vitest";
import { ApiError } from "../api/errors";
import type { Channel } from "../api/types";
import { channelActions, channelErrorText, channelNameError, defaultChannel } from "./channels";

const ch = (id: string, name: string, by = "x", is_default = false) =>
  ({ id, team_id: "t", name, topic: "", is_default, created_by_member_id: by, last_message_seq: 0, created_at: "" }) as Channel;
const general = ch("g", "general", "o", true);
const dev = ch("d", "dev", "m");

describe("频道菜单权限（§5.1）", () => {
  it("owner/admin：改名 + 删除；默认频道只有改名", () => {
    expect(channelActions("owner", "o", dev)).toEqual(["rename", "delete"]);
    expect(channelActions("admin", "a", dev)).toEqual(["rename", "delete"]);
    expect(channelActions("owner", "o", general)).toEqual(["rename"]);
  });
  it("普通成员：自己创建的频道只能改名，别人的什么都没有（不显示菜单）", () => {
    expect(channelActions("member", "m", dev)).toEqual(["rename"]);
    expect(channelActions("member", "z", dev)).toEqual([]);
    expect(channelActions("member", "z", general)).toEqual([]);
  });
  it("置顶未开放，不出现", () => {
    expect(channelActions("owner", "o", dev)).not.toContain("pin");
  });
});

describe("频道名校验 / 默认频道 / 错误提示", () => {
  it("1–64 字符、去空白、同名（忽略大小写，排除自己）", () => {
    expect(channelNameError("  ", [general, dev])).toBe("频道名不能为空");
    expect(channelNameError("字".repeat(65), [])).toBe("频道名最多 64 个字符");
    expect(channelNameError("字".repeat(64), [])).toBeNull();
    expect(channelNameError("DEV", [general, dev])).toBe("已有同名频道");
    expect(channelNameError("dev", [general, dev], "d")).toBeNull();
  });
  it("默认频道优先 is_default", () => {
    expect(defaultChannel([dev, ch("g2", "lobby", "o", true)])?.id).toBe("g2");
    expect(defaultChannel([dev, general])?.id).toBe("g");
  });
  it("中文错误", () => {
    expect(channelErrorText(ApiError.fromBody(409, { error: { code: "conflict", message: "x" } }, ""), "rename")).toBe("改名失败：已有同名频道");
    expect(channelErrorText(ApiError.fromBody(403, { error: { code: "forbidden", message: "x" } }, ""), "delete")).toBe(
      "删除频道失败：你没有权限删除这个频道（默认频道不能删除）",
    );
    expect(channelErrorText(new Error("x"), "rename")).toBe("改名失败：网络异常，请稍后再试");
  });
});
