import type { FrameHandler, RealtimeClient } from "../client";
import { wsUrl } from "../config";
import type { ClientFrame, ReadyData, ServerFrame } from "../types";

/**
 * WebSocket 实时通道（docs/api.md §8）：
 * - 连接 /api/v1/ws，open 后 5 秒内发 {type:"auth",token}；
 * - 收到 ready 后才算连上；close code 4401 = 鉴权失败，不重连；
 * - 每 25 秒发 ping；断线指数退避重连（1s,2s,4s…最多 30s），重连后由页面用 after=<seq> 补拉。
 */
export function createWsRealtime(): RealtimeClient {
  let ws: WebSocket | null = null;
  let token: string | null = null;
  let stopped = true;
  let retry = 0;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  const frameHandlers = new Set<FrameHandler>();
  const readyHandlers = new Set<(d: ReadyData) => void>();
  const authFailedHandlers = new Set<() => void>();

  const send = (f: ClientFrame) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify(f));

  function clearTimers() {
    if (pingTimer) clearInterval(pingTimer);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    pingTimer = null;
    reconnectTimer = null;
  }

  function open() {
    if (!token || stopped) return;
    const sock = new WebSocket(wsUrl());
    ws = sock;
    sock.onopen = () => {
      send({ type: "auth", token: token! });
    };
    sock.onmessage = (ev) => {
      let frame: ServerFrame;
      try {
        frame = JSON.parse(String(ev.data)) as ServerFrame;
      } catch {
        return;
      }
      if (frame.type === "ready") {
        retry = 0;
        if (pingTimer) clearInterval(pingTimer);
        pingTimer = setInterval(() => send({ type: "ping" }), 25_000);
        readyHandlers.forEach((h) => h(frame.data as ReadyData));
      }
      frameHandlers.forEach((h) => h(frame));
    };
    sock.onclose = (ev) => {
      if (ws === sock) ws = null;
      if (pingTimer) clearInterval(pingTimer);
      pingTimer = null;
      if (ev.code === 4401) {
        stopped = true;
        authFailedHandlers.forEach((h) => h());
        return;
      }
      if (stopped) return;
      const delay = Math.min(30_000, 1000 * 2 ** retry);
      retry += 1;
      reconnectTimer = setTimeout(open, delay);
    };
  }

  return {
    connect(t) {
      token = t;
      if (!stopped && ws) return;
      stopped = false;
      retry = 0;
      open();
    },
    disconnect() {
      stopped = true;
      clearTimers();
      ws?.close(1000);
      ws = null;
    },
    subscribe(handler) {
      frameHandlers.add(handler);
      return () => frameHandlers.delete(handler);
    },
    onReady(handler) {
      readyHandlers.add(handler);
      return () => readyHandlers.delete(handler);
    },
    onAuthFailed(handler) {
      authFailedHandlers.add(handler);
      return () => authFailedHandlers.delete(handler);
    },
  };
}
