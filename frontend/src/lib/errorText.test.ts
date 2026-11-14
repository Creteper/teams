import { describe, expect, it } from "vitest";
import { ApiError } from "../api/errors";
import { NETWORK_ERROR_TEXT, errorText } from "./errorText";

describe("errorText：不把英文原始报错展示给用户", () => {
  it("网络错误 → 中文", () => {
    expect(errorText(new ApiError(0, "network_error", NETWORK_ERROR_TEXT))).toBe("网络异常，请检查网络后重试");
    expect(errorText(new TypeError("Failed to fetch"))).toBe(NETWORK_ERROR_TEXT);
    expect(errorText(new TypeError("Load failed"))).toBe(NETWORK_ERROR_TEXT);
  });
  it("后端中文 message 原样显示", () => {
    expect(errorText(new ApiError(404, "not_found", "频道 不存在"))).toBe("频道 不存在");
  });
  it("网关 / statusText 英文 → 按状态码给中文", () => {
    expect(errorText(new ApiError(502, "http_error", "Bad Gateway", undefined, "r1"))).toBe("服务器暂时不可用，请稍后再试（请求编号 r1）");
    expect(errorText(new ApiError(413, "http_error", "Payload Too Large"))).toBe("文件太大");
    expect(errorText(new ApiError(400, "bad_request", "invalid json"), "保存失败")).toBe("保存失败（错误码 bad_request）");
  });
  it("其他英文异常 → 兜底中文；自己抛的中文 Error 保留", () => {
    expect(errorText(new Error("Cannot read properties of undefined"))).toBe("操作失败，请稍后再试");
    expect(errorText(new Error("上传失败：图片尺寸不能超过 4096×4096"))).toBe("上传失败：图片尺寸不能超过 4096×4096");
    expect(errorText(new DOMException("The user aborted a request.", "AbortError"))).toBe("已取消");
  });
});
