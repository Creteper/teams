import { useCallback, useEffect, useRef } from "react";

export interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/** 距底部不超过 threshold 像素算“在底部” */
export function isAtBottom(m: ScrollMetrics, threshold = 80): boolean {
  return m.scrollHeight - m.scrollTop - m.clientHeight <= threshold;
}

/**
 * 聊天列表“贴底”：用户在底部时，内容变高（新消息、图片加载）或可视区变矮
 * （输入框上方出现 bot 状态条、上传卡片、多行输入）都自动滚到底；用户往上翻时不打扰。
 * 用 ResizeObserver 同时观察滚动容器和内容容器，不依赖具体是谁改变了高度。
 */
export function useStickToBottom(threshold = 80) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    atBottomRef.current = true;
  }, []);

  const stickIfNeeded = useCallback(() => {
    if (atBottomRef.current) scrollToBottom();
  }, [scrollToBottom]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (el) atBottomRef.current = isAtBottom(el, threshold);
  }, [threshold]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => stickIfNeeded());
    ro.observe(el);
    if (contentRef.current) ro.observe(contentRef.current);
    return () => ro.disconnect();
  }, [stickIfNeeded]);

  return { scrollRef, contentRef, atBottomRef, onScroll, stickIfNeeded, scrollToBottom };
}
