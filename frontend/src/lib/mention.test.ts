import { describe, expect, it } from "vitest";
import {
  extractMentionIds,
  filterCandidates,
  getMentionQuery,
  insertMention,
  parseContent,
  serializeMentions,
  toPlainText,
  type MentionCandidate,
} from "./mention";

const members: MentionCandidate[] = [
  { id: "m-alice", name: "Alice", kind: "user" },
  { id: "m-bob", name: "Bob", kind: "user" },
  { id: "m-grok", name: "Grok", kind: "bot" },
  { id: "m-grok2", name: "Grok Helper", kind: "bot" },
];

describe("getMentionQuery", () => {
  it("在开头或空白后的 @ 触发", () => {
    expect(getMentionQuery("@gr", 3)).toEqual({ start: 0, query: "gr" });
    expect(getMentionQuery("hi @B", 5)).toEqual({ start: 3, query: "B" });
    expect(getMentionQuery("hi @", 4)).toEqual({ start: 3, query: "" });
    expect(getMentionQuery("好的，@Gr", 6)).toEqual({ start: 3, query: "Gr" });
  });
  it("邮箱、已结束的 @ 不触发", () => {
    expect(getMentionQuery("a@b.com", 7)).toBeNull();
    expect(getMentionQuery("@Bob hi", 7)).toBeNull();
    expect(getMentionQuery("no mention", 10)).toBeNull();
  });
});

describe("filterCandidates", () => {
  it("用户和 bot 都能匹配，前缀优先，不区分大小写", () => {
    expect(filterCandidates(members, "gr").map((c) => c.id)).toEqual(["m-grok", "m-grok2"]);
    expect(filterCandidates(members, "").length).toBe(4);
    expect(filterCandidates(members, "elp").map((c) => c.id)).toEqual(["m-grok2"]);
  });
});

describe("insertMention", () => {
  it("替换 @query 为 @名字 并移动光标", () => {
    expect(insertMention("hi @gr there", 3, 6, "Grok")).toEqual({ text: "hi @Grok  there", caret: 9 });
  });
});

describe("serializeMentions", () => {
  it("把已选成员的 @名字 转成 <@member_id>，长名优先，去重", () => {
    const picked = [members[2], members[3], members[1]];
    const r = serializeMentions("@Grok Helper 和 @Grok 看下，@Bob @Bob", picked);
    expect(r.content).toBe("<@m-grok2> 和 <@m-grok> 看下，<@m-bob> <@m-bob>");
    expect(r.mentionIds).toEqual(["m-grok2", "m-grok", "m-bob"]);
  });
  it("未选中的 @文本 和邮箱保持原样", () => {
    const r = serializeMentions("mail a@Bob.com @Carol", [members[1]]);
    expect(r.content).toBe("mail a@Bob.com @Carol");
    expect(r.mentionIds).toEqual([]);
  });
});

describe("parseContent / extractMentionIds", () => {
  const names: Record<string, string> = { "m-alice": "Alice", "m-grok": "Grok" };
  const lookup = (id: string) => names[id];
  it("<@id> 渲染为名字，未知 id 原样保留", () => {
    const content = "<@m-grok> 你好 <@m-unknown> 和 <@m-alice>";
    expect(parseContent(content, lookup)).toEqual([
      { type: "mention", id: "m-grok", name: "Grok" },
      { type: "text", text: " 你好 <@m-unknown> 和 " },
      { type: "mention", id: "m-alice", name: "Alice" },
    ]);
    expect(toPlainText(content, lookup)).toBe("@Grok 你好 <@m-unknown> 和 @Alice");
    expect(extractMentionIds(content + " <@m-grok>")).toEqual(["m-grok", "m-unknown", "m-alice"]);
  });
});
