import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GifAvatarDialog } from "./GifAvatarDialog";

beforeEach(() => {
  URL.createObjectURL = vi.fn(() => "blob:gif-1");
  URL.revokeObjectURL = vi.fn();
});
afterEach(cleanup);

describe("GifAvatarDialog（动图头像不裁剪、不转码）", () => {
  const file = new File([new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 10, 0, 10, 0])], "cat.gif", { type: "image/gif" });
  it("用 <img> 预览原文件（不画 canvas），object-cover 居中，并提示居中裁切", async () => {
    render(<GifAvatarDialog file={file} size={{ width: 10, height: 10 }} onCancel={() => {}} onConfirm={async () => {}} />);
    const big = (await screen.findByTestId("gif-preview-large")) as HTMLImageElement;
    expect(big.tagName).toBe("IMG");
    expect(big.getAttribute("src")).toBe("blob:gif-1");
    expect(big.className).toContain("object-cover");
    expect(big.className).toContain("object-center");
    expect(document.querySelector("canvas")).toBeNull();
    expect(screen.getByTestId("gif-center-hint").textContent).toContain("动图会居中裁切显示");
    // 两个小预览左右排（和静态图裁剪弹窗一致）
    const small = screen.getByTestId("gif-preview-small");
    expect(small.className).toContain("flex");
    expect(small.className).not.toContain("flex-col");
    expect(small.querySelectorAll("img")).toHaveLength(2);
  });
  it("确认 → onConfirm；失败显示错误", async () => {
    const onConfirm = vi.fn(async () => {
      throw new Error("上传失败：图片不能超过 5 MB");
    });
    render(<GifAvatarDialog file={file} size={{ width: 10, height: 10 }} onCancel={() => {}} onConfirm={onConfirm} />);
    fireEvent.click(await screen.findByRole("button", { name: "使用这个动图" }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalled());
    expect(await screen.findByText("上传失败：图片不能超过 5 MB")).toBeTruthy();
  });
});
