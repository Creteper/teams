import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/errors";
import { remainingSeconds, retryAfterSeconds, useCooldown } from "./cooldown";

describe("限流倒计时", () => {
  it("remainingSeconds 向上取整、不为负", () => {
    expect(remainingSeconds(10_000, 0)).toBe(10);
    expect(remainingSeconds(10_000, 9_001)).toBe(1);
    expect(remainingSeconds(10_000, 10_000)).toBe(0);
    expect(remainingSeconds(10_000, 20_000)).toBe(0);
  });
  it("retryAfterSeconds 只认 rate_limited，优先 Retry-After", () => {
    expect(retryAfterSeconds(ApiError.fromBody(429, null, "", { retryAfter: "17" }))).toBe(17);
    expect(retryAfterSeconds(ApiError.fromBody(429, null, ""))).toBe(30);
    expect(retryAfterSeconds(ApiError.fromBody(401, { error: { code: "unauthorized", message: "x" } }, ""))).toBeNull();
    expect(retryAfterSeconds(new Error("x"))).toBeNull();
  });

  describe("useCooldown", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());
    it("start 后每秒递减，结束归零", () => {
      const { result } = renderHook(() => useCooldown());
      expect(result.current.remaining).toBe(0);
      act(() => result.current.start(3));
      expect(result.current.remaining).toBe(3);
      act(() => void vi.advanceTimersByTime(1000));
      expect(result.current.remaining).toBe(2);
      act(() => void vi.advanceTimersByTime(2100));
      expect(result.current.remaining).toBe(0);
    });
  });
});
