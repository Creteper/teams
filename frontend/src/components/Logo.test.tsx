import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Logo, LogoWordmark } from "./Logo";

afterEach(cleanup);

describe("Logo（E 版）", () => {
  it("小尺寸用 192 图，大尺寸用 512 图，圆角裁切", () => {
    render(<Logo size={48} />);
    const img = screen.getByAltText("TeAms") as HTMLImageElement;
    expect(img.getAttribute("src")).toBe("/icons/icon-192.png");
    expect(img.className).toContain("rounded-[23%]");
    cleanup();
    render(<Logo size={128} />);
    expect(screen.getByAltText("TeAms").getAttribute("src")).toBe("/icons/icon-512.png");
  });
  it("文字标也用同一个 logo", () => {
    render(<LogoWordmark size={36} />);
    expect(screen.getByTestId("teams-logo").getAttribute("src")).toBe("/icons/icon-192.png");
  });
});
