import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/errors";

const login = vi.fn();
vi.mock("../auth/AuthContext", () => ({ useAuth: () => ({ user: null, login }) }));
import LoginPage from "./LoginPage";

describe("登录页 429 倒计时", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    login.mockReset();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("限流期间按钮禁用并显示剩余秒数，结束后恢复", async () => {
    login.mockRejectedValue(ApiError.fromBody(429, null, "", { retryAfter: "3" }));
    render(
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByLabelText("用户名"), { target: { value: "alice" } });
    fireEvent.change(screen.getByLabelText("密码"), { target: { value: "pw" } });
    await act(async () => {
      fireEvent.submit(screen.getByLabelText("用户名").closest("form")!);
    });
    const btn = () => screen.getByRole("button", { name: /秒后再试|登录/ });
    expect(btn().textContent).toContain("请 3 秒后再试");
    expect(btn().hasAttribute("disabled") || btn().getAttribute("aria-disabled") === "true" || btn().hasAttribute("data-disabled")).toBe(true);
    // 限流不标红输入框
    expect(screen.getByLabelText("用户名").closest("[data-invalid=true]")).toBeNull();
    await act(async () => void vi.advanceTimersByTime(1000));
    expect(btn().textContent).toContain("请 2 秒后再试");
    await act(async () => void vi.advanceTimersByTime(2500));
    expect(btn().textContent).toBe("登录");
    expect(btn().hasAttribute("disabled")).toBe(false);
  });

  it("401：用户名和密码都标红（HeroUI invalid 状态）", async () => {
    login.mockRejectedValue(ApiError.fromBody(401, { error: { code: "unauthorized", message: "用户名或密码错误" } }, ""));
    render(
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByLabelText("用户名"), { target: { value: "alice" } });
    fireEvent.change(screen.getByLabelText("密码"), { target: { value: "bad" } });
    await act(async () => {
      fireEvent.submit(screen.getByLabelText("用户名").closest("form")!);
    });
    expect(screen.getByText("用户名或密码错误")).toBeTruthy();
    expect(screen.getByLabelText("用户名").getAttribute("data-invalid") ?? screen.getByLabelText("用户名").getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByLabelText("密码").getAttribute("data-invalid") ?? screen.getByLabelText("密码").getAttribute("aria-invalid")).toBe("true");
  });
});
