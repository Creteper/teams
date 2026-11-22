import { HighlightStyle, LanguageDescription, syntaxHighlighting, syntaxTree } from "@codemirror/language";
import { markdown } from "@codemirror/lang-markdown";
import { javascriptLanguage, jsxLanguage, tsxLanguage, typescriptLanguage } from "@codemirror/lang-javascript";
import { cssLanguage } from "@codemirror/lang-css";
import { htmlLanguage } from "@codemirror/lang-html";
import { tags } from "@lezer/highlight";
import type { EditorState, Range } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type ViewUpdate } from "@codemirror/view";

const json = LanguageDescription.of({ name: "JSON", load: async () => (await import("@codemirror/lang-json")).json() });
const python = LanguageDescription.of({ name: "Python", load: async () => (await import("@codemirror/lang-python")).python() });
const fencedLanguages = new Map([
  ["js", javascriptLanguage], ["javascript", javascriptLanguage], ["jsx", jsxLanguage],
  ["ts", typescriptLanguage], ["typescript", typescriptLanguage], ["tsx", tsxLanguage],
  ["html", htmlLanguage], ["css", cssLanguage],
]);
const syntax = markdown({
  addKeymap: false, completeHTMLTags: false, pasteURLAsLink: false,
  codeLanguages(info) {
    const name = info.toLowerCase();
    if (name === "json") return json;
    if (name === "py" || name === "python") return python;
    return fencedLanguages.get(name) ?? null;
  },
});
const highlight = syntaxHighlighting(HighlightStyle.define([
  { tag: [tags.keyword, tags.bool, tags.null], class: "md-token-keyword" },
  { tag: [tags.string, tags.special(tags.string)], class: "md-token-string" },
  { tag: tags.number, class: "md-token-number" },
  { tag: tags.comment, class: "md-token-comment" },
  { tag: [tags.tagName, tags.typeName, tags.propertyName, tags.attributeName], class: "md-token-name" },
]));

class Bullet extends WidgetType {
  toDOM() {
    const span = document.createElement("span");
    span.textContent = "•";
    span.setAttribute("aria-hidden", "true");
    return span;
  }
}
const bullet = Decoration.replace({ widget: new Bullet() });
const hide = Decoration.replace({});
const marker = Decoration.mark({ class: "md-marker" });
const codeLine = Decoration.line({ class: "md-block" });
const quoteLine = Decoration.line({ class: "md-quote-line" });

/** Compact chat uses Enter for newlines until the closing fence has been typed. */
export function inMarkdownCode(state: EditorState, pos: number, blockOnly = false): boolean {
  for (let n = syntaxTree(state).resolve(pos, -1); n; ) {
    if (n.name === "FencedCode") {
      const last = n.lastChild;
      return !(last?.name === "CodeMark" && last.from !== n.firstChild?.from && pos >= last.to);
    }
    if (n.name === "CodeBlock" || (!blockOnly && n.name === "InlineCode" && pos < n.to)) return true;
    if (!n.parent) break;
    n = n.parent;
  }
  return false;
}

function decorate(view: EditorView) {
  const ranges: Range<Decoration>[] = [];
  const { doc, selection } = view.state;
  const tree = syntaxTree(view.state);
  const focused = view.hasFocus;
  const touches = (from: number, to: number) => focused &&
    selection.ranges.some(r => r.from <= to && r.to >= from);
  const mark = (from: number, to: number, style: string) => {
    if (from < to) ranges.push(Decoration.mark({ class: style }).range(from, to));
  };
  for (const visible of view.visibleRanges) {
    const addLines = (from: number, to: number, decoration: Decoration) => {
      const first = doc.lineAt(Math.max(from, visible.from)).number;
      const last = doc.lineAt(Math.min(to, visible.to)).number;
      for (let i = first; i <= last; i++) ranges.push(decoration.range(doc.line(i).from));
    };
    tree.iterate({ ...visible, enter(node) {
      const { from, to, name } = node;
      if (from === to) return;
      const parent = node.node.parent;
      let inlineGroup = parent;
      while (inlineGroup?.parent && ["StrongEmphasis", "Emphasis", "Link"].includes(inlineGroup.parent.name)) {
        inlineGroup = inlineGroup.parent;
      }
      switch (name) {
        case "FencedCode":
          addLines(from, to, codeLine);
          break;
        case "CodeBlock": addLines(from, to, codeLine); return false;
        case "CodeText": return false;
        case "Blockquote": addLines(from, to, quoteLine); break;
        case "HorizontalRule":
          if (!touches(from, to)) {
            ranges.push(Decoration.line({ class: "md-rule" }).range(doc.lineAt(from).from), hide.range(from, to));
          }
          break;
        case "CodeInfo": mark(from, to, "md-code-info"); break;
        case "InlineCode": mark(from, to, "md-code"); break;
        case "StrongEmphasis": mark(from, to, "md-strong"); break;
        case "Emphasis": mark(from, to, "md-em"); break;
        case "Link": mark(from, to, "md-link"); break;
        case "HeaderMark":
        case "QuoteMark":
        case "ListMark":
        case "CodeMark": {
          const line = doc.lineAt(from);
          const inline = name === "CodeMark" && parent?.name === "InlineCode";
          const active = inline && inlineGroup ? touches(inlineGroup.from, inlineGroup.to) : touches(line.from, line.to);
          if (name === "ListMark" && /^\d/.test(doc.sliceString(from, to))) {
            ranges.push(marker.range(from, to));
          } else {
            const decoration = active ? marker : name === "ListMark" ? bullet : hide;
            ranges.push(decoration.range(from, to));
          }
          break;
        }
        case "EmphasisMark":
        case "LinkMark":
        case "LinkTitle":
        case "URL":
          if (inlineGroup && (name === "EmphasisMark" || parent?.name === "Link")) {
            ranges.push((touches(inlineGroup.from, inlineGroup.to) ? marker : hide).range(from, to));
          }
          break;
        default:
          if (/^(ATX|Setext)Heading[1-6]$/.test(name)) mark(from, to, "md-heading");
      }
    } });
    // An empty code span has no CommonMark node yet. Style it without consuming keystrokes.
    for (const match of view.state.sliceDoc(visible.from, visible.to).matchAll(/(?<![\\`])``(?!`)/g)) {
      const start = visible.from + match.index;
      if (tree.resolveInner(start + 1).name === "Paragraph") mark(start, start + 2, "md-empty-code");
    }
  }
  return Decoration.set(ranges, true);
}

const preview = ViewPlugin.fromClass(class {
  decorations;
  constructor(view: EditorView) { this.decorations = decorate(view); }
  update(update: ViewUpdate) {
    if (update.docChanged || update.selectionSet || update.focusChanged || update.viewportChanged ||
        syntaxTree(update.startState) !== syntaxTree(update.state)) this.decorations = decorate(update.view);
  }
}, { decorations: plugin => plugin.decorations });

export const liveMarkdown = [syntax, preview, highlight];
