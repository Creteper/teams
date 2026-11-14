import { describe, expect, it } from "vitest";
import { charCount, parseInviteInput, validateTeamFields } from "./text";

describe("charCount / validateTeamFields", () => {
  it("按 Unicode 字符计数（emoji 算 1）", () => {
    expect(charCount("开发组👍")).toBe(4);
  });
  it("名称 1–50、简介 ≤500，首尾空白不计", () => {
    expect(validateTeamFields("  ", "")).toBe("名称不能为空");
    expect(validateTeamFields("a".repeat(50), "")).toBeNull();
    expect(validateTeamFields("字".repeat(51), "")).toContain("50");
    expect(validateTeamFields("ok", "x".repeat(500))).toBeNull();
    expect(validateTeamFields("ok", "x".repeat(501))).toContain("500");
    expect(validateTeamFields(` ${"a".repeat(50)} `, "")).toBeNull();
  });
});

describe("parseInviteInput", () => {
  it("支持完整链接、路径和纯邀请码", () => {
    expect(parseInviteInput("http://localhost:5190/invite/OpenLab8")).toBe("OpenLab8");
    expect(parseInviteInput("/invite/Ab_9-x?x=1")).toBe("Ab_9-x");
    expect(parseInviteInput(" OpenLab8 ")).toBe("OpenLab8");
    expect(parseInviteInput("not a code!")).toBeNull();
    expect(parseInviteInput("")).toBeNull();
  });
});
