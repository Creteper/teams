import { describe, expect, it } from "vitest";
import { filterCandidates, getMentionQuery, mentionKeyAction } from "./mention";

describe("@ 补全键盘", () => {
  it("上下方向键循环移动", () => {
    expect(mentionKeyAction("ArrowDown", 3, 0)).toEqual({ type: "move", index: 1 });
    expect(mentionKeyAction("ArrowDown", 3, 2)).toEqual({ type: "move", index: 0 });
    expect(mentionKeyAction("ArrowUp", 3, 0)).toEqual({ type: "move", index: 2 });
  });
  it("Enter / Tab 选中当前项，越界会夹紧", () => {
    expect(mentionKeyAction("Enter", 3, 1)).toEqual({ type: "pick", index: 1 });
    expect(mentionKeyAction("Tab", 2, 5)).toEqual({ type: "pick", index: 1 });
  });
  it("Esc 关闭；没有匹配时只响应 Esc", () => {
    expect(mentionKeyAction("Escape", 3, 0)).toEqual({ type: "close" });
    expect(mentionKeyAction("Escape", 0, 0)).toEqual({ type: "close" });
    expect(mentionKeyAction("Enter", 0, 0)).toBeNull();
    expect(mentionKeyAction("a", 3, 0)).toBeNull();
  });
  it("输入后过滤；无匹配返回空（界面显示“没有匹配的成员”）", () => {
    const cands = [
      { id: "1", name: "Alice", kind: "user" as const },
      { id: "2", name: "Grok", kind: "bot" as const },
    ];
    const q = getMentionQuery("hi @gr", 6)!;
    expect(filterCandidates(cands, q.query).map((c) => c.id)).toEqual(["2"]);
    expect(filterCandidates(cands, "zzz")).toEqual([]);
  });
});
