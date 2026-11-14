import { describe, expect, it } from "vitest";
import { avatarFileError, clampCrop, initialCrop, outputSize, outputType, sniffImage, sourceRect, zoomAt, AVATAR_MAX_BYTES } from "./avatarCrop";

const bytes = (...b: number[]) => new Uint8Array([...b, ...new Array(16).fill(0)]);

describe("头像文件校验", () => {
  it("按文件头嗅探 jpg/png/gif/webp，其它为 null", () => {
    expect(sniffImage(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe("image/jpeg");
    expect(sniffImage(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe("image/png");
    expect(sniffImage(bytes(0x47, 0x49, 0x46, 0x38, 0x39, 0x61))).toBe("image/gif");
    expect(sniffImage(bytes(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50))).toBe("image/webp");
    expect(sniffImage(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
  });
  it("中文提示：格式不对、超过 5MB、空文件", () => {
    expect(avatarFileError(100, null)).toBe("只支持 jpg、png、gif、webp 格式的图片");
    expect(avatarFileError(100, "image/svg+xml")).toBe("只支持 jpg、png、gif、webp 格式的图片");
    expect(avatarFileError(AVATAR_MAX_BYTES + 1, "image/png")).toMatch(/^图片不能超过 5 MB/);
    expect(avatarFileError(AVATAR_MAX_BYTES, "image/png")).toBeNull();
    expect(avatarFileError(0, "image/png")).toBe("文件是空的，请重新选择");
  });
});

describe("裁剪几何", () => {
  const W = 800, H = 400, V = 200; // 横图，短边 400 → baseScale 0.5
  it("初始：铺满取景框并居中；源区域是中间的正方形", () => {
    const s = initialCrop(W, H, V);
    expect(s).toEqual({ zoom: 1, x: -100, y: 0 });
    expect(sourceRect(s, W, H, V)).toEqual({ sx: 200, sy: 0, size: 400 });
  });
  it("拖动被夹住：图片始终盖满取景框", () => {
    expect(clampCrop({ zoom: 1, x: 50, y: 30 }, W, H, V)).toEqual({ zoom: 1, x: 0, y: 0 });
    expect(clampCrop({ zoom: 1, x: -999, y: -999 }, W, H, V)).toEqual({ zoom: 1, x: -200, y: 0 });
    expect(sourceRect({ zoom: 1, x: -200, y: 0 }, W, H, V)).toEqual({ sx: 400, sy: 0, size: 400 });
  });
  it("以中心放大 2 倍：源区域变成一半且仍居中", () => {
    const s = zoomAt(initialCrop(W, H, V), 2, V / 2, V / 2, W, H, V);
    expect(s.zoom).toBe(2);
    expect(sourceRect(s, W, H, V)).toEqual({ sx: 300, sy: 100, size: 200 });
  });
  it("缩放范围 1–4", () => {
    expect(zoomAt(initialCrop(W, H, V), 0.2, 0, 0, W, H, V).zoom).toBe(1);
    expect(zoomAt(initialCrop(W, H, V), 10, 0, 0, W, H, V).zoom).toBe(4);
  });
  it("输出：jpeg→jpeg，其它→png；边长最多 512、不放大小图", () => {
    expect(outputType("image/jpeg")).toBe("image/jpeg");
    expect(outputType("image/gif")).toBe("image/png");
    expect(outputSize(4000)).toBe(512);
    expect(outputSize(300)).toBe(300);
    expect(outputSize(10)).toBe(64);
  });
});
