// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { Composer } from "./Composer";

afterEach(cleanup);

const base = { channelName: "general", members: [], onUpload: vi.fn(), onSend: vi.fn() };

describe("Composer autoFocus", () => {
  it("autoFocus 时挂载后焦点在输入框，并回调 onAutoFocused", () => {
    const done = vi.fn();
    const { container } = render(<Composer {...base} autoFocus onAutoFocused={done} />);
    expect(document.activeElement).toBe(container.querySelector('[role="textbox"]'));
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("默认不抢焦点", () => {
    const { container } = render(<Composer {...base} />);
    expect(document.activeElement).not.toBe(container.querySelector('[role="textbox"]'));
  });
});


it("编辑区即时渲染代码徽标，发送时保留 Markdown 和缩进", () => {
  const onSend = vi.fn();
  const { getByRole } = render(<Composer {...base} onSend={onSend} />);
  const input = getByRole("textbox", { name: "消息输入框" });
  const content = "    code\n\n`badge`";
  act(() => EditorView.findFromDOM(input)!.dispatch({ changes: { from: 0, insert: content } }));
  expect(input.querySelector(".md-code")?.textContent).toBe("badge");
  fireEvent.keyDown(input, { key: "Enter" });
  expect(onSend).toHaveBeenCalledWith(expect.objectContaining({ content }));
  expect(input.querySelector(".md-code")).toBeNull();
});
