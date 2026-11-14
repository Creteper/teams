import { describe, expect, it } from "vitest";
import { ApiError } from "../api/errors";
import { formatBytes, installDir, skillErrorText } from "./skill";

describe("skill 工具函数", () => {
  it("formatBytes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(12994)).toBe("12.7 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
  });
  it("installDir：从 install_path 推出默认目录", () => {
    expect(installDir(".cursor/skills/teams-bot-integration/SKILL.md")).toBe("./.cursor/skills/teams-bot-integration/");
    expect(installDir("./agent/SKILL.md")).toBe("./agent/");
    expect(installDir(undefined)).toBe("./.cursor/skills/teams-bot-integration/");
  });
  it("skillErrorText：503 skill_unavailable / 网络错误 / 其他", () => {
    expect(skillErrorText(new ApiError(503, "skill_unavailable", "x"))).toContain("暂时不可用");
    expect(skillErrorText(new ApiError(0, "network_error", "x"))).toContain("网络错误");
    expect(skillErrorText(new ApiError(500, "internal", "炸了"))).toBe("获取 Skill 信息失败：炸了");
  });
});
