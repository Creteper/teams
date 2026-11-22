import type { Element, ElementContent, Root } from "hast";
import Markdown from "react-markdown";
import { parseContent } from "../lib/mention";

/** 在 Markdown 解析后解析提及，保留粗体、列表等上下文，代码中的示例按原文显示。 */
export function MessageMarkdown({ text, mentionName, myMemberId }: {
  text: string; mentionName?: (id: string) => string | undefined; myMemberId?: string;
}) {
  function mentions() {
    function visit(parent: Root | Element) {
      for (let i = parent.children.length - 1; i >= 0; i--) {
        const child = parent.children[i];
        if (child.type === "element" && child.tagName !== "code" && child.tagName !== "pre") visit(child);
        if (child.type !== "text" || !child.value.includes("<@") || !mentionName) continue;
        const nodes = parseContent(child.value, mentionName).map<ElementContent>(part =>
          part.type === "text" ? { type: "text", value: part.text } : {
            type: "element", tagName: "span",
            properties: { className: part.id === myMemberId ? ["message-mention", "self"] : ["message-mention"] },
            children: [{ type: "text", value: "@" + part.name }],
          });
        parent.children.splice(i, 1, ...nodes);
      }
    }
    return visit;
  }

  return <div className="issue-markdown message-markdown">
    <Markdown rehypePlugins={mentionName && text.includes("<@") ? [mentions] : []}>{text}</Markdown>
  </div>;
}
