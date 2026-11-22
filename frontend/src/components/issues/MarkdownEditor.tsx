import { useRef, useState } from "react";
import Markdown from "react-markdown";
import type { EditorView } from "@codemirror/view";
import { LiveMarkdownInput } from "../LiveMarkdownInput";

// Titles appear inside links, headings and buttons. Keep their markup inline.
export function MarkdownTitle({ text, links = false }: { text: string; links?: boolean }) {
  return <span className="issue-markdown-title"><Markdown skipHtml unwrapDisallowed
    allowedElements={links ? ["strong", "em", "code", "a"] : ["strong", "em", "code"]}>{text}</Markdown></span>;
}

export function MarkdownBody({ text }: { text: string }) {
  return <div className="issue-markdown"><Markdown skipHtml>{text}</Markdown></div>;
}

export function MarkdownEditor({ value, change, disabled = false }: {
  value: string; change: (v: string) => void; disabled?: boolean;
}) {
  const [preview, setPreview] = useState(false);
  const ref = useRef<EditorView>(null);
  function format(before: string, after: string, placeholder: string) {
    const el = ref.current;
    if (!el) return;
    const { from: start, to: end } = el.state.selection.main;
    const selected = value.slice(start, end) || placeholder;
    el.dispatch({ changes: { from: start, to: end, insert: before + selected + after },
      selection: { anchor: start + before.length, head: start + before.length + selected.length }, userEvent: "input" });
    el.focus();
  }
  return <div className="issue-md-editor">
    <div className="issue-md-toolbar">
      <button type="button" aria-pressed={!preview} onClick={() => setPreview(false)}>编辑</button>
      <button type="button" aria-pressed={preview} onClick={() => setPreview(true)}>预览</button>
      {!preview && <div className="ml-auto flex gap-1">
        <button type="button" disabled={disabled} aria-label="加粗" title="加粗" onClick={() => format("**","**","粗体")}><strong>B</strong></button>
        <button type="button" disabled={disabled} aria-label="斜体" title="斜体" onClick={() => format("*","*","斜体")}><em>I</em></button>
        <button type="button" disabled={disabled} aria-label="行内代码" title="行内代码" onClick={() => format("`","`","代码")}>{"</>"}</button>
      </div>}
    </div>
    {preview ? <div className="issue-md-preview">{value ? <MarkdownBody text={value} /> : <span>暂无描述</span>}</div> :
      <LiveMarkdownInput editorRef={ref} label="描述" disabled={disabled} className="issue-description"
        hint="添加 Markdown 描述…" maxLength={32000} value={value} onChange={change} />}
  </div>;
}
