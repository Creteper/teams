import { describe, expect, it } from "vitest";
import { checkUpload } from "./upload";

const MB = 1024 * 1024;

describe("checkUpload", () => {
  it("允许的图片/视频类型", () => {
    expect(checkUpload({ name: "a.png", type: "image/png", size: MB })).toEqual({ ok: true, kind: "image" });
    expect(checkUpload({ name: "a.mov", type: "video/quicktime", size: 50 * MB })).toEqual({ ok: true, kind: "video" });
  });
  it("超限和不支持的类型被拒", () => {
    expect(checkUpload({ name: "big.jpg", type: "image/jpeg", size: 10 * MB + 1 }).ok).toBe(false);
    expect(checkUpload({ name: "big.mp4", type: "video/mp4", size: 100 * MB + 1 }).ok).toBe(false);
    expect(checkUpload({ name: "a.svg", type: "image/svg+xml", size: 10 }).ok).toBe(false);
    expect(checkUpload({ name: "a.pdf", type: "application/pdf", size: 10 }).ok).toBe(false);
  });
});
