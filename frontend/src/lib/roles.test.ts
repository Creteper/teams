import { describe, expect, it } from "vitest";
import { isManager, roleLabel } from "./roles";
import { teamColor, teamInitials } from "../components/TeamIcon";

describe("roleLabel", () => {
  it("中文角色名", () => {
    expect(roleLabel("owner")).toBe("所有者");
    expect(roleLabel("admin")).toBe("管理员");
    expect(roleLabel("member")).toBe("成员");
    expect(roleLabel("bot")).toBe("Bot");
    expect(roleLabel(undefined)).toBe("");
    expect(isManager("admin")).toBe(true);
    expect(isManager("member")).toBe(false);
  });
});

describe("TeamIcon 辅助", () => {
  it("颜色由 id 决定且稳定；首字母规则", () => {
    expect(teamColor("abc")).toBe(teamColor("abc"));
    expect(teamInitials("TeAms 开发组")).toBe("TE");
    expect(teamInitials("设计评审")).toBe("设");
    expect(teamInitials("Open Lab")).toBe("OL");
  });
});
