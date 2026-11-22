import { act, cleanup, render } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { LiveMarkdownInput } from "./LiveMarkdownInput";

afterEach(cleanup);

function editor(text: string) {
  const { getByRole } = render(<LiveMarkdownInput label="正文" hint="" value={text} onChange={() => {}} />);
  const input = getByRole("textbox", { name: "正文" });
  const view = EditorView.findFromDOM(input)!;
  function select(anchor: number, head = anchor) {
    act(() => { view.focus(); view.dispatch({ selection: { anchor, head } }); });
  }
  return { input, view, select };
}

describe("Markdown live preview", () => {
  it.each([
    ["**bold**", "bold"], ["_em_", "em"], ["`code`", "code"],
    ["# heading", "heading"], ["[link](https://example.com)", "link"],
  ])("光标和选区中的 %s 保留标记，移开后收起", (source, rendered) => {
    const { input, select, view } = editor(source + "\nnext");
    select(source.length);
    expect(input.firstElementChild?.textContent).toBe(source);
    select(view.state.doc.length);
    expect(input.firstElementChild?.textContent?.trim()).toBe(rendered);
    select(0, view.state.doc.length);
    expect(input.firstElementChild?.textContent).toBe(source);
  });
  it("未闭合围栏内的空行也属于代码块", () => {
    const { input } = editor("```js\nconst x = 1\n\nx");
    expect(input.querySelectorAll(".cm-line.md-block")).toHaveLength(4);
  });
});

describe("Markdown code blocks", () => {
  it.each([
    ["~~~\nfirst\n\nlast\n~~~", 5],
    ["````text\n```\n````", 3],
    ["    indented\n    body", 2],
    ["```unknown-language\n**literal markers**\n```", 3],
  ])("保留代码缩进、空行和字面符号 %s", (source, lines) => {
    const { input, select, view } = editor(source);
    select(0, source.length);
    expect(input.querySelectorAll(".md-block")).toHaveLength(lines);
    expect(input.querySelector(".md-strong")).toBeNull();
    expect(view.state.doc.toString()).toBe(source);
  });
  it("失去焦点时显示预览，回到原选区时恢复源码", () => {
    const { input, select, view } = editor("`text`");
    select(2);
    expect(input.textContent).toBe("`text`");
    act(() => input.blur());
    act(() => view.dispatch({}));
    expect(input.textContent).toBe("text");
    select(2);
    expect(input.textContent).toBe("`text`");
  });
});
