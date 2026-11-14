import { describe, expect, it } from "vitest";
import { avatarMode } from "./avatar";

describe("avatarMode 优先级", () => {
  it("avatar_shape/avatar_color > avatar_url > 首字母", () => {
    expect(avatarMode({ display_name: "G", avatar_shape: "blob", avatar_color: null, avatar_url: "/x" })).toBe("procedural");
    expect(avatarMode({ display_name: "G", avatar_color: "black" })).toBe("procedural");
    expect(avatarMode({ display_name: "G", avatar_url: "/api/v1/avatars/1", avatar_shape: null })).toBe("image");
    expect(avatarMode({ display_name: "G", avatar_url: null })).toBe("initials");
  });
});
