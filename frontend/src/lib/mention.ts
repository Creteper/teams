/**
 * @ 补全与 `<@member_id>` 编解码（docs/api.md §4.2）。纯函数，便于测试。
 *
 * 输入框里显示 `@显示名`，选人时记录 {id,name}；发送前用 serializeMentions 转成 `<@member_id>`。
 * 渲染时用 parseContent 把 `<@id>` 替换为 `@显示名`。
 */

export interface MentionCandidate {
  id: string;
  name: string;
  kind: "user" | "bot";
}

/** "@" 前一个字符若是这些（邮箱/用户名字符），就不视为提及 */
const NOT_BEFORE_AT = /[A-Za-z0-9_.+-]/;
const canStartMention = (text: string, at: number) => at === 0 || !NOT_BEFORE_AT.test(text[at - 1]);

export interface MentionQuery {
  start: number;
  query: string;
}

/** 光标前最近的 "@"（位于开头或非邮箱字符后，如空白、中文标点），且到光标之间无空白时，进入补全 */
export function getMentionQuery(text: string, caret: number): MentionQuery | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf("@");
  if (at < 0) return null;
  if (!canStartMention(before, at)) return null;
  const query = before.slice(at + 1);
  if (/\s/.test(query)) return null;
  return { start: at, query };
}

/** 前缀匹配优先，其次包含匹配；不区分大小写 */
export function filterCandidates<T extends MentionCandidate>(candidates: T[], query: string, limit = 8): T[] {
  const q = query.toLowerCase();
  const prefix: T[] = [];
  const contains: T[] = [];
  for (const c of candidates) {
    const name = c.name.toLowerCase();
    if (name.startsWith(q)) prefix.push(c);
    else if (name.includes(q)) contains.push(c);
  }
  return [...prefix, ...contains].slice(0, limit);
}

export function insertMention(text: string, start: number, caret: number, name: string): { text: string; caret: number } {
  const inserted = `@${name} `;
  return { text: text.slice(0, start) + inserted + text.slice(caret), caret: start + inserted.length };
}

/**
 * 把输入框文本里已选成员的 `@名字` 转成 `<@member_id>`（名字长的优先，避免前缀冲突）。
 * 返回线上格式正文和被 @ 的 id（去重、按首次出现顺序）。
 */
export function serializeMentions(text: string, picked: MentionCandidate[]): { content: string; mentionIds: string[] } {
  const targets = [...new Map(picked.map((p) => [p.id, p])).values()].sort((a, b) => b.name.length - a.name.length);
  let out = "";
  const ids: string[] = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] === "@" && canStartMention(text, i)) {
      const hit = targets.find((t) => text.startsWith(`@${t.name}`, i));
      if (hit) {
        out += `<@${hit.id}>`;
        if (!ids.includes(hit.id)) ids.push(hit.id);
        i += hit.name.length + 1;
        continue;
      }
    }
    out += text[i];
    i += 1;
  }
  return { content: out, mentionIds: ids };
}

const TOKEN_RE = /<@([0-9A-Za-z_-]+)>/g;

/** 从线上格式正文里取出所有 `<@id>`（去重、保持顺序） */
export function extractMentionIds(content: string): string[] {
  const ids: string[] = [];
  for (const m of content.matchAll(TOKEN_RE)) if (!ids.includes(m[1])) ids.push(m[1]);
  return ids;
}

export type ContentPart = { type: "text"; text: string } | { type: "mention"; id: string; name: string };

/**
 * 把 `<@id>` 解析为提及片段。lookup 查不到名字（非本 team 成员）时按文档“原样保留为文本”。
 */
export function parseContent(content: string, lookup: (id: string) => string | undefined): ContentPart[] {
  const parts: ContentPart[] = [];
  let last = 0;
  for (const m of content.matchAll(TOKEN_RE)) {
    const idx = m.index ?? 0;
    const name = lookup(m[1]);
    if (name === undefined) continue;
    if (idx > last) parts.push({ type: "text", text: content.slice(last, idx) });
    parts.push({ type: "mention", id: m[1], name });
    last = idx + m[0].length;
  }
  if (last < content.length) parts.push({ type: "text", text: content.slice(last) });
  return parts;
}

/** 纯文本预览：`<@id>` → `@名字` */
export function toPlainText(content: string, lookup: (id: string) => string | undefined): string {
  return parseContent(content, lookup)
    .map((p) => (p.type === "text" ? p.text : `@${p.name}`))
    .join("");
}

export type MentionKeyAction = { type: "move"; index: number } | { type: "pick"; index: number } | { type: "close" } | null;

/**
 * @ 补全弹层的键盘处理（纯函数）：↑/↓ 循环移动，Enter/Tab 选中，Esc 关闭。
 * count=0（“没有匹配的成员”）时只响应 Esc，Enter 交给发送逻辑。
 */
export function mentionKeyAction(key: string, count: number, index: number): MentionKeyAction {
  if (key === "Escape") return { type: "close" };
  if (count <= 0) return null;
  const i = Math.min(Math.max(index, 0), count - 1);
  if (key === "ArrowDown") return { type: "move", index: (i + 1) % count };
  if (key === "ArrowUp") return { type: "move", index: (i - 1 + count) % count };
  if (key === "Enter" || key === "Tab") return { type: "pick", index: i };
  return null;
}
