import { describe, expect, it } from "vitest";
import { ApiError } from "../api/errors";
import type { Channel } from "../api/types";
import { channelActions, channelErrorText, channelNameError, defaultChannel } from "./channels";

const ch = (id: string, name: string, by = "x", is_default = false) =>
  ({ id, team_id: "t", name, topic: "", is_default, created_by_member_id: by, last_message_seq: 0, created_at: "" }) as Channel;
const general = ch("g", "general", "o", true);
const dev = ch("d", "dev", "m");

describe("频道菜单权限（§5.1 / §5.7）", () => {
  it("owner/admin：置顶 + 改名 + 删除；默认频道没有删除", () => {
    expect(channelActions("owner", "o", dev)).toEqual(["pin", "rename", "delete"]);
    expect(channelActions("admin", "a", dev)).toEqual(["pin", "rename", "delete"]);
    expect(channelActions("owner", "o", general)).toEqual(["pin", "rename"]);
  });
  it("普通成员：所有频道都能置顶；自己创建的频道才能改名", () => {
    expect(channelActions("member", "m", dev)).toEqual(["pin", "rename"]);
    expect(channelActions("member", "z", dev)).toEqual(["pin"]);
    expect(channelActions("member", "z", general)).toEqual(["pin"]);
  });
  it("已置顶 → 取消置顶（看参数或 channel.pinned）", () => {
    expect(channelActions("member", "z", dev, true)).toEqual(["unpin"]);
    expect(channelActions("member", "z", { ...dev, pinned: true })).toEqual(["unpin"]);
  });
});

describe("频道名校验 / 默认频道 / 错误提示", () => {
  it("1–64 字符、去空白、同名（忽略大小写，排除自己）", () => {
    expect(channelNameError("  ", [general, dev])).toBe("频道名不能为空");
    expect(channelNameError("字".repeat(65), [])).toBe("频道名不能超过 64 个字");
    expect(channelNameError("字".repeat(64), [])).toBeNull();
    expect(channelNameError("DEV", [general, dev])).toBe("已有同名频道");
    expect(channelNameError("dev", [general, dev], "d")).toBeNull();
  });
  it("只禁止控制字符（与后端 unicode.IsControl 一致），其它字符不比后端严", () => {
    for (const ok of ["#发布 🚀", "a/b\\c", "<script>", "前端 · 讨论", "😀".repeat(64)]) expect(channelNameError(ok, [])).toBeNull();
    for (const bad of ["a\nb", "a\tb", "a\u0000b", "a\u007fb", "a\u0085b"]) expect(channelNameError(bad, [])).toBe("频道名不能包含换行、制表符等控制字符");
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
