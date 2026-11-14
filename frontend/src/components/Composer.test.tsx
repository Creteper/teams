// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { Composer } from "./Composer";

afterEach(cleanup);

const base = { channelName: "general", members: [], onUpload: vi.fn(), onSend: vi.fn() };

describe("Composer autoFocus", () => {
  it("autoFocus 时挂载后焦点在输入框，并回调 onAutoFocused", () => {
    const done = vi.fn();
    const { container } = render(<Composer {...base} autoFocus onAutoFocused={done} />);
    expect(document.activeElement).toBe(container.querySelector("textarea"));
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("默认不抢焦点", () => {
    const { container } = render(<Composer {...base} />);
    expect(document.activeElement).not.toBe(container.querySelector("textarea"));
  });
});
