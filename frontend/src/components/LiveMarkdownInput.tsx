import { useLayoutEffect, useRef, type RefObject } from "react";
import { EditorState, Compartment, Prec, Transaction } from "@codemirror/state";
import { EditorView, keymap, placeholder } from "@codemirror/view";
import { liveMarkdown } from "./liveMarkdown";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import "./markdown-input.css";

interface Props {
  value: string; onChange(text: string): void; label: string; hint: string;
  className?: string; disabled?: boolean; singleLine?: boolean; maxLength?: number; autoFocus?: boolean;
  editorRef?: RefObject<EditorView | null>; onCaret?(offset: number): void;
  onKeyDown?(event: KeyboardEvent, view: EditorView): boolean;
  onOverflowChange?(overflow: boolean): void;
}

export function LiveMarkdownInput(props: Props) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const editable = useRef(new Compartment());
  useLayoutEffect(() => {
    const p = latest.current;
    const view = new EditorView({
      parent: host.current!,
      doc: p.value,
      extensions: [
        liveMarkdown, history(), EditorView.lineWrapping,
        placeholder(p.hint), EditorView.contentAttributes.of({
          "aria-label": p.label, "aria-multiline": String(!p.singleLine), spellcheck: "true",
        }),
        editable.current.of([EditorView.editable.of(!p.disabled), EditorState.readOnly.of(!!p.disabled)]),
        EditorState.transactionFilter.of(tr => {
          if (!tr.docChanged) return tr;
          if (latest.current.maxLength && tr.newDoc.length > latest.current.maxLength) return [];
          if (p.singleLine && tr.newDoc.lines > 1) {
            return { changes: { from: 0, to: tr.startState.doc.length, insert: tr.newDoc.sliceString(0, undefined, " ") },
              selection: tr.newSelection };
          }
          return tr;
        }),
        Prec.highest(EditorView.domEventHandlers({ keydown(event, editor) {
          if (event.isComposing || editor.composing || event.keyCode === 229) return false;
          if (p.singleLine && event.key === "Enter") { event.preventDefault(); return true; }
          return latest.current.onKeyDown?.(event, editor) ?? false;
        } })),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        EditorView.updateListener.of(update => {
          if (update.docChanged) latest.current.onChange(update.state.doc.toString());
          if (update.docChanged || update.selectionSet) latest.current.onCaret?.(update.state.selection.main.head);
        }),
      ],
    });
    viewRef.current = view;
    if (p.editorRef) p.editorRef.current = view;
    if (p.autoFocus) view.focus();
    const observer = p.onOverflowChange && typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => {
      latest.current.onOverflowChange?.(view.scrollDOM.scrollHeight > view.scrollDOM.clientHeight + 1);
    }) : null;
    observer?.observe(view.contentDOM);
    observer?.observe(view.scrollDOM);
    return () => {
      observer?.disconnect(); view.destroy(); viewRef.current = null;
      if (p.editorRef) p.editorRef.current = null;
    };
  }, []);

  useLayoutEffect(() => {
    const view = viewRef.current;
    if (view && props.value !== view.state.doc.toString()) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: props.value },
        annotations: Transaction.addToHistory.of(false) });
    }
  }, [props.value]);
  useLayoutEffect(() => {
    viewRef.current?.dispatch({ effects: editable.current.reconfigure([EditorView.editable.of(!props.disabled), EditorState.readOnly.of(!!props.disabled)]) });
  }, [props.disabled]);
  return <div ref={host} className={`live-markdown ${props.className ?? ""}`} />;
}
