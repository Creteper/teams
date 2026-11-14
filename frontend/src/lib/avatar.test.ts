import { describe, expect, it } from "vitest";
import { avatarMode } from "./avatar";
import { resolveColor, resolveShape } from "../components/BotAvatar";

describe("avatarMode 优先级", () => {
  it("avatar_shape/avatar_color > avatar_url > 首字母", () => {
    expect(avatarMode({ display_name: "G", avatar_shape: "blob", avatar_color: null, avatar_url: "/x" })).toBe("procedural");
    expect(avatarMode({ display_name: "G", avatar_color: "black" })).toBe("procedural");
    expect(avatarMode({ display_name: "G", avatar_url: "/api/v1/avatars/1", avatar_shape: null })).toBe("image");
    expect(avatarMode({ display_name: "G", avatar_url: null })).toBe("initials");
    // 空白字符串视为未设置
    expect(avatarMode({ display_name: "G", avatar_shape: "  ", avatar_color: "", avatar_url: "/x" })).toBe("image");
    expect(avatarMode({ display_name: "G", avatar_shape: " Capsule " })).toBe("procedural");
  });
});

describe("BotAvatar resolve：后端原样存储的 shape/color", () => {
  it("trim + 忽略大小写匹配，未知值回退", () => {
    expect(resolveShape(" Capsule ")).toBe("capsule");
    expect(resolveShape("STAR")).toBe("star");
    expect(resolveColor(" VIOLET ")).toBe("violet");
    expect(resolveColor("Blue")).toBe("blue");
    expect(resolveShape("no-such-shape")).toBe("blob");
    expect(resolveColor(null)).toBe("black");
  });
});
