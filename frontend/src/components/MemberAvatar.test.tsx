import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MemberAvatar } from "./MemberAvatar";

afterEach(cleanup);

describe("MemberAvatar", () => {
  it("bot 程序化头像：没有外圈底色、描边或 ring，形状占满头像尺寸", () => {
    const { container } = render(
      <MemberAvatar member={{ id: "b", display_name: "Dean", avatar_url: null, avatar_shape: "blob", avatar_color: "black" }} size={40} />,
    );
    const wrap = container.querySelector('[data-avatar="bot"]') as HTMLElement;
    expect(wrap).toBeTruthy();
    expect(wrap.className).not.toMatch(/ring|border|bg-|shadow|outline/);
    const svg = wrap.querySelector("svg")!;
    expect(svg.getAttribute("width")).toBe("40");
    expect(svg.querySelector("[stroke]")).toBeNull();
  });
  it("用户图片头像保持原样（object-cover 居中）", () => {
    const { container } = render(<MemberAvatar member={{ id: "u", display_name: "Alice", avatar_url: "/a.gif" }} size={40} />);
    expect(container.querySelector('[data-avatar="bot"]')).toBeNull();
  });
});
