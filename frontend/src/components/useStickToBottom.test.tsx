import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isAtBottom, useStickToBottom } from "./useStickToBottom";

let roCallbacks: (() => void)[] = [];
class FakeResizeObserver {
  cb: () => void;
  constructor(cb: () => void) {
    this.cb = cb;
    roCallbacks.push(cb);
  }
  observe() {}
  disconnect() {}
}

function setMetrics(el: HTMLElement, m: { scrollHeight: number; clientHeight: number }) {
  Object.defineProperty(el, "scrollHeight", { configurable: true, value: m.scrollHeight });
  Object.defineProperty(el, "clientHeight", { configurable: true, value: m.clientHeight });
}

let api: ReturnType<typeof useStickToBottom>;
function Harness() {
  api = useStickToBottom();
  return (
    <div ref={api.scrollRef} onScroll={api.onScroll} data-testid="scroll">
      <div ref={api.contentRef} />
    </div>
  );
}
const resize = () => act(() => roCallbacks.forEach((cb) => cb()));

describe("isAtBottom", () => {
  it("距底部 ≤ 阈值算在底部", () => {
    expect(isAtBottom({ scrollTop: 520, scrollHeight: 1000, clientHeight: 400 })).toBe(true);
    expect(isAtBottom({ scrollTop: 500, scrollHeight: 1000, clientHeight: 400 }, 80)).toBe(false);
  });
});

describe("useStickToBottom（状态条/上传卡片出现时不遮挡最后一条）", () => {
  beforeEach(() => {
    roCallbacks = [];
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = FakeResizeObserver;
  });
  afterEach(() => {
    cleanup();
    delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
  });

  it("原本在底部：可视区变矮（输入框上方出现状态条）→ 自动滚到底", () => {
    const { getByTestId } = render(<Harness />);
    const el = getByTestId("scroll");
    setMetrics(el, { scrollHeight: 1000, clientHeight: 600 });
    el.scrollTop = 400; // 在底部
    act(() => el.dispatchEvent(new Event("scroll")));
    setMetrics(el, { scrollHeight: 1000, clientHeight: 520 }); // 状态条占了 80px
    resize();
    expect(el.scrollTop).toBe(1000); // 浏览器会夹紧到 480，即最后一条完整可见
    expect(api.atBottomRef.current).toBe(true);
  });

  it("原本在底部：内容变高（图片加载 / 新消息）→ 跟到底", () => {
    const { getByTestId } = render(<Harness />);
    const el = getByTestId("scroll");
    setMetrics(el, { scrollHeight: 800, clientHeight: 600 });
    el.scrollTop = 200;
    act(() => el.dispatchEvent(new Event("scroll")));
    setMetrics(el, { scrollHeight: 1100, clientHeight: 600 });
    resize();
    expect(el.scrollTop).toBe(1100);
  });

  it("用户已往上翻：高度变化不打扰当前位置", () => {
    const { getByTestId } = render(<Harness />);
    const el = getByTestId("scroll");
    setMetrics(el, { scrollHeight: 2000, clientHeight: 600 });
    el.scrollTop = 300;
    act(() => el.dispatchEvent(new Event("scroll")));
    setMetrics(el, { scrollHeight: 2000, clientHeight: 520 });
    resize();
    expect(el.scrollTop).toBe(300);
    expect(api.atBottomRef.current).toBe(false);
  });
});
