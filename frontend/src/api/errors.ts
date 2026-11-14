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

  static fromBody(status: number, body: Partial<ApiErrorBody> | null, fallback: string): ApiError {
    const e = body?.error;
    return new ApiError(status, e?.code ?? "http_error", e?.message ?? fallback, e?.details, body?.request_id);
  }
}
