import { describe, expect, it } from "vitest";
import { ApiError } from "./errors";

describe("ApiError.fromBody", () => {
  it("429 rate_limited 转成中文友好提示，带 Retry-After 秒数", () => {
    const e = ApiError.fromBody(429, { error: { code: "rate_limited", message: "too many" }, request_id: "req_1" }, "", { retryAfter: "17" });
    expect(e.message).toBe("操作太频繁了，请 17 秒后再试");
    expect(e.details?.retry_after).toBe(17);
    expect(e.requestId).toBe("req_1");
    expect(ApiError.fromBody(429, null, "Too Many Requests").message).toBe("操作太频繁了，请稍后再试");
  });
  it("其它错误保留后端 message；request_id 回退到 X-Request-Id", () => {
    const e = ApiError.fromBody(409, { error: { code: "owner_cannot_leave", message: "owner cannot leave" } }, "", { requestId: "req_h" });
    expect(e).toMatchObject({ status: 409, code: "owner_cannot_leave", message: "owner cannot leave", requestId: "req_h" });
  });
});
