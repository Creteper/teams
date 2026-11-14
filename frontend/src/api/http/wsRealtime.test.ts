import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerFrame } from "../types";
import { createWsRealtime } from "./wsRealtime";

class FakeWs {
  static OPEN = 1;
  static all: FakeWs[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  constructor(public url: string) {
    FakeWs.all.push(this);
  }
  send(d: string) {
    this.sent.push(d);
  }
  close() {
    // 浏览器里 close 是异步的
    setTimeout(() => {
      this.readyState = 3;
      this.onclose?.({ code: 1000 });
    }, 10);
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  push(f: object) {
    this.onmessage?.({ data: JSON.stringify(f) });
  }
}

describe("wsRealtime：disconnect 后立刻 connect（StrictMode）只保留一条连接", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWs.all = [];
    vi.stubGlobal("WebSocket", FakeWs);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("旧 socket 关闭不触发重连，事件只收一次", () => {
    const rt = createWsRealtime();
    const got: ServerFrame[] = [];
    rt.subscribe((f) => got.push(f));
    rt.connect("tok");
    rt.disconnect();
    rt.connect("tok");
    expect(FakeWs.all).toHaveLength(2);
    vi.advanceTimersByTime(60_000); // 旧 socket 的 onclose 已触发，且足够长于退避重连时间
    expect(FakeWs.all).toHaveLength(2);
    const [old, cur] = FakeWs.all;
    cur.open();
    expect(cur.sent).toContain(JSON.stringify({ type: "auth", token: "tok" }));
    old.push({ type: "member.updated", team_id: "t", data: {} });
    cur.push({ type: "member.updated", team_id: "t", data: {} });
    expect(got.filter((f) => f.type === "member.updated")).toHaveLength(1);
    rt.disconnect();
  });

  it("当前 socket 异常断开仍会退避重连", () => {
    const rt = createWsRealtime();
    rt.connect("tok");
    const s = FakeWs.all[0];
    s.open();
    s.onclose?.({ code: 1006 });
    vi.advanceTimersByTime(1000);
    expect(FakeWs.all).toHaveLength(2);
    rt.disconnect();
  });
});
