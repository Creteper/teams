import type { ApiErrorBody } from "./types";

/** 统一错误：对应 docs/api.md §0.2 的 {error:{code,message,details},request_id} */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;
  readonly requestId?: string;
  constructor(status: number, code: string, message: string, details?: Record<string, unknown>, requestId?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.requestId = requestId;
  }

  static fromBody(
    status: number,
    body: Partial<ApiErrorBody> | null,
    fallback: string,
    extra: { retryAfter?: string | null; requestId?: string | null } = {},
  ): ApiError {
    const e = body?.error;
    const code = e?.code ?? (status === 429 ? "rate_limited" : "http_error");
    const requestId = body?.request_id ?? extra.requestId ?? undefined;
    if (code === "rate_limited") {
      const sec = Number(extra.retryAfter);
      const wait = Number.isFinite(sec) && sec > 0 ? `请 ${Math.ceil(sec)} 秒后再试` : "请稍后再试";
      return new ApiError(status, code, `操作太频繁了，${wait}`, { ...e?.details, retry_after: Number.isFinite(sec) ? sec : undefined }, requestId);
    }
    return new ApiError(status, code, e?.message ?? fallback, e?.details, requestId);
  }
}
