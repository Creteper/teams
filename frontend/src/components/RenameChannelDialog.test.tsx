// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Channel } from "../api/types";
import { RenameChannelDialog } from "./RenameChannelDialog";

const ch = (id: string, name: string): Channel => ({
  id,
  team_id: "t1",
  name,
  topic: "",
  is_default: name === "general",
  created_by_member_id: "m1",
  last_message_seq: 0,
  created_at: "2026-11-15T00:00:00Z",
});
const channels = [ch("c1", "general"), ch("c2", "frontend"), ch("c3", "random")];

function setup(onSubmit = vi.fn(async () => {})) {
  render(<RenameChannelDialog channel={channels[2]} channels={channels} onSubmit={onSubmit} onClose={() => {}} />);
  const input = screen.getByLabelText(/频道名/) as HTMLInputElement;
  return { input, onSubmit };
}
const errorText = () => screen.queryByTestId("channel-name-error")?.textContent ?? null;
const fieldInvalid = () => document.querySelector('[data-field="channel-name"]')?.getAttribute("data-invalid");

afterEach(cleanup);

describe("RenameChannelDialog 本地校验", () => {
  it("刚打开、未改动：不标红、无错误", () => {
    const { input } = setup();
    expect(input.value).toBe("random");
    expect(errorText()).toBeNull();
    expect(fieldInvalid()).not.toBe("true");
    expect(input.getAttribute("aria-invalid")).toBeNull();
  });

  it("重名（不区分大小写）：立即标红并显示「已有同名频道」，按钮禁用", () => {
    const { input, onSubmit } = setup();
    fireEvent.change(input, { target: { value: "Frontend" } });
    expect(errorText()).toContain("已有同名频道");
    expect(fieldInvalid()).toBe("true");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toBe("channel-name-error");
    const btn = screen.getByRole("button", { name: "保存" });
    expect(btn.hasAttribute("disabled") || btn.getAttribute("aria-disabled") === "true" || btn.hasAttribute("data-disabled")).toBe(true);
    fireEvent.submit(input.closest("form")!);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("空名 / 只有空格：显示「频道名不能为空」", () => {
    const { input } = setup();
    fireEvent.change(input, { target: { value: "   " } });
    expect(errorText()).toContain("频道名不能为空");
    expect(fieldInvalid()).toBe("true");
  });

  it("超过 64 个字：显示「频道名不能超过 64 个字」", () => {
    const { input } = setup();
    fireEvent.change(input, { target: { value: "字".repeat(65) } });
    expect(errorText()).toContain("频道名不能超过 64 个字");
  });

  it("改回合法名字后错误消失", () => {
    const { input } = setup();
    fireEvent.change(input, { target: { value: "" } });
    expect(errorText()).not.toBeNull();
    fireEvent.change(input, { target: { value: "随便聊聊" } });
    expect(errorText()).toBeNull();
    expect(fieldInvalid()).not.toBe("true");
  });

  it("服务端 409 也显示在输入框下方", async () => {
    const { ApiError } = await import("../api/errors");
    const err = Object.assign(Object.create(ApiError.prototype), { status: 409, code: "conflict", message: "频道名已存在" });
    const { input } = setup(vi.fn(async () => { throw err; }));
    fireEvent.change(input, { target: { value: "新名字" } });
    fireEvent.submit(input.closest("form")!);
    expect(await screen.findByTestId("channel-name-error")).toHaveProperty("textContent", expect.stringContaining("已有同名频道"));
    expect(fieldInvalid()).toBe("true");
  });
});
