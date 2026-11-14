import { describe, expect, it } from "vitest";
import { inviteStatus, reasonFromErrorCode, safeRedirect, withRedirect } from "./invite";

const now = Date.parse("2026-11-14T15:00:00.000Z");
const base = { revoked_at: null, expires_at: null, max_uses: null, uses: 0 };

describe("inviteStatus", () => {
  it("永久不限次为有效", () => {
    expect(inviteStatus(base, now)).toBe("active");
    expect(inviteStatus({ ...base, uses: 999 }, now)).toBe("active");
  });
  it("过期 / 作废 / 次数用尽", () => {
    expect(inviteStatus({ ...base, expires_at: "2026-11-14T14:59:59.000Z" }, now)).toBe("expired");
    expect(inviteStatus({ ...base, expires_at: "2026-11-14T15:00:00.000Z" }, now)).toBe("expired");
    expect(inviteStatus({ ...base, expires_at: "2026-11-14T15:00:01.000Z" }, now)).toBe("active");
    expect(inviteStatus({ ...base, revoked_at: "2026-11-14T10:00:00.000Z" }, now)).toBe("revoked");
    expect(inviteStatus({ ...base, max_uses: 5, uses: 5 }, now)).toBe("exhausted");
    expect(inviteStatus({ ...base, max_uses: 5, uses: 4 }, now)).toBe("active");
  });
  it("优先级：作废 > 过期 > 用尽", () => {
    expect(
      inviteStatus({ revoked_at: "2026-11-14T10:00:00.000Z", expires_at: "2026-11-13T00:00:00.000Z", max_uses: 1, uses: 1 }, now),
    ).toBe("revoked");
    expect(inviteStatus({ ...base, expires_at: "2026-11-13T00:00:00.000Z", max_uses: 1, uses: 1 }, now)).toBe("expired");
  });
  it("410 错误码映射", () => {
    expect(reasonFromErrorCode("invite_exhausted")).toBe("exhausted");
    expect(reasonFromErrorCode("invite_not_found")).toBe("not_found");
    expect(reasonFromErrorCode("forbidden")).toBeNull();
  });
});

describe("safeRedirect", () => {
  it("接受站内路径（保留 query/hash）", () => {
    expect(safeRedirect("/invite/AbC123")).toBe("/invite/AbC123");
    expect(safeRedirect("/teams/x/channels/y?a=1#m")).toBe("/teams/x/channels/y?a=1#m");
  });
  it("拒绝开放重定向和异常输入，回退默认", () => {
    for (const bad of [
      "//evil.com",
      "/\\evil.com",
      "https://evil.com",
      "javascript:alert(1)",
      "evil.com",
      "/%0a//evil",
      "/a\nb",
      "",
      null,
      undefined,
    ]) {
      const r = safeRedirect(bad as string | null | undefined);
      expect(r.startsWith("/") && !r.startsWith("//")).toBe(true);
      if (bad !== "/%0a//evil") expect(r).toBe("/teams");
    }
    expect(safeRedirect("//evil.com", "/home")).toBe("/home");
  });
  it("withRedirect 编码目标", () => {
    expect(withRedirect("/login", "/invite/A?x=1")).toBe("/login?redirect=%2Finvite%2FA%3Fx%3D1");
  });
});
