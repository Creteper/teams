import { useCallback, useEffect, useState } from "react";
import { ApiError } from "../api/errors";

/** 剩余整秒（向上取整，不小于 0） */
export function remainingSeconds(untilMs: number, nowMs: number): number {
  return Math.max(0, Math.ceil((untilMs - nowMs) / 1000));
}

/** 限流错误的等待秒数：优先 Retry-After（details.retry_after），否则给默认值；非限流错误返回 null */
export function retryAfterSeconds(err: unknown, fallback = 30): number | null {
  if (!(err instanceof ApiError) || err.code !== "rate_limited") return null;
  const s = Number(err.details?.retry_after);
  return Number.isFinite(s) && s > 0 ? Math.ceil(s) : fallback;
}

/** 倒计时：start(秒) 后 remaining 每秒递减到 0 */
export function useCooldown() {
  const [until, setUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (until <= Date.now()) return;
    const t = setInterval(() => {
      const n = Date.now();
      setNow(n);
      if (n >= until) clearInterval(t);
    }, 250);
    return () => clearInterval(t);
  }, [until]);
  const start = useCallback((seconds: number) => {
    const n = Date.now();
    setNow(n);
    setUntil(n + seconds * 1000);
  }, []);
  return { remaining: remainingSeconds(until, now), start };
}
