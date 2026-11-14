import { ApiError } from "../api/errors";

export type LoginField = "username" | "password";
export type RegisterField = "username" | "display_name" | "password" | "confirm";

/** 登录失败要标红的字段：限流不标；401 认证失败两项都标（不区分是哪项错，避免枚举用户名） */
export function loginErrorFields(err: unknown): LoginField[] {
  if (!(err instanceof ApiError) || err.code === "rate_limited") return [];
  if (err.status === 401) return ["username", "password"];
  const f = err.details?.field;
  if (f === "username" || f === "password") return [f];
  return [];
}

/** 注册失败要标红的字段：409 用户名占用 → 用户名；details.field 指明字段 → 该字段；限流不标 */
export function registerErrorFields(err: unknown): RegisterField[] {
  if (!(err instanceof ApiError) || err.code === "rate_limited") return [];
  const f = err.details?.field;
  if (f === "username" || f === "password" || f === "display_name") return [f];
  if (err.status === 409) return ["username"];
  return [];
}

/** 注册前本地校验：返回第一处错误的字段和提示 */
export function validateRegister(v: { username: string; password: string; confirm: string }): { field: RegisterField; message: string } | null {
  if (!/^[a-z0-9_]{3,32}$/.test(v.username.trim().toLowerCase()))
    return { field: "username", message: "用户名需 3–32 位，只能包含小写字母、数字和下划线" };
  if (v.password.length < 8) return { field: "password", message: "密码至少 8 位" };
  if (v.password !== v.confirm) return { field: "confirm", message: "两次输入的密码不一致" };
  return null;
}
