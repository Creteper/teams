import { describe, expect, it } from "vitest";
import { ApiError } from "../api/errors";
import { loginErrorFields, registerErrorFields, validateRegister } from "./authForm";

const err = (status: number, code: string, details?: Record<string, unknown>) =>
  ApiError.fromBody(status, { error: { code, message: "x", details } }, "x");

describe("登录/注册错误 → 标红字段", () => {
  it("登录 401 标用户名和密码；限流不标", () => {
    expect(loginErrorFields(err(401, "unauthorized"))).toEqual(["username", "password"]);
    expect(loginErrorFields(ApiError.fromBody(429, null, "", { retryAfter: "5" }))).toEqual([]);
    expect(loginErrorFields(new Error("network"))).toEqual([]);
  });
  it("注册 409 标用户名；details.field 指定字段", () => {
    expect(registerErrorFields(err(409, "conflict"))).toEqual(["username"]);
    expect(registerErrorFields(err(400, "invalid_argument", { field: "password" }))).toEqual(["password"]);
    expect(registerErrorFields(err(400, "invalid_argument"))).toEqual([]);
  });
  it("本地校验按顺序定位第一处错误", () => {
    expect(validateRegister({ username: "A!", password: "12345678", confirm: "12345678" })?.field).toBe("username");
    expect(validateRegister({ username: "alice", password: "123", confirm: "123" })?.field).toBe("password");
    expect(validateRegister({ username: "alice", password: "12345678", confirm: "1234567x" })?.field).toBe("confirm");
    expect(validateRegister({ username: "alice", password: "12345678", confirm: "12345678" })).toBeNull();
  });
});
