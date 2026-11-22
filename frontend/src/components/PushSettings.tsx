import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { Button, Label, Switch } from "@heroui/react";
import { api } from "../api";
import {
  CHROME_GFW_HINT,
  currentPushState,
  detectPushSupport,
  disablePush,
  enablePush,
  NOTIFICATION_LOG_EVENT,
  readNotificationLog,
  SW_SCOPE,
  pushErrorText,
  unsupportedText,
} from "../lib/push";
import { FormError } from "./FormField";

function subscribeToLog(onChange: () => void) {
  window.addEventListener(NOTIFICATION_LOG_EVENT, onChange);
  return () => window.removeEventListener(NOTIFICATION_LOG_EVENT, onChange);
}

type Phase = { kind: "loading" } | { kind: "hidden" } | { kind: "unsupported"; text: string } | { kind: "ready"; on: boolean; denied: boolean; subscribed: boolean };

/**
 * 「开启频道消息通知」开关（docs/api.md §9.4）：
 * - 服务器未配置推送（enabled=false）→ 整个入口不显示；
 * - 浏览器不支持 → 显示说明；
 * - 只有点开关时才请求通知权限。
 */
export function PushSettings({ token, userId, hiddenFallback = null }: { token: string; userId: string; hiddenFallback?: ReactNode }) {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const log = useSyncExternalStore(subscribeToLog, () => readNotificationLog(userId));

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cfg = await api.getVapidPublicKey(token);
        if (cancelled) return;
        if (!cfg.enabled || !cfg.public_key) return setPhase({ kind: "hidden" });
        setPublicKey(cfg.public_key);
        const support = detectPushSupport();
        if (!support.ok) return setPhase({ kind: "unsupported", text: unsupportedText(support.reason) });
        const st = await currentPushState(userId).catch(() => ({ on: false, subscribed: false, permission: Notification.permission }));
        if (!cancelled) setPhase({ kind: "ready", on: st.on, subscribed: st.subscribed, denied: st.permission === "denied" });
      } catch {
        // 拿不到配置就不显示入口（不影响其他功能）
        if (!cancelled) setPhase({ kind: "hidden" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, userId]);

  if (phase.kind === "loading") return null;
  if (phase.kind === "hidden") return <>{hiddenFallback}</>;

  async function toggle(next: boolean) {
    if (!publicKey) return;
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      if (next) {
        const mode = await enablePush(api, token, userId, publicKey);
        setPhase({ kind: "ready", on: true, subscribed: mode === "push", denied: false });
        setNotice(mode === "online" ? "已开启在线提醒。离线推送未连接，请保持 TeAms 标签页打开。" : "已开启频道消息通知。网页关闭后的提醒依赖浏览器推送服务。");
      } else {
        await disablePush(api, token);
        setPhase({ kind: "ready", on: false, subscribed: false, denied: false });
        setNotice("已关闭频道消息通知。");
      }
    } catch (e) {
      setError(pushErrorText(e));
      if (Notification.permission === "denied") setPhase({ kind: "ready", on: false, subscribed: false, denied: true });
    } finally {
      setPending(false);
    }
  }

  async function testNotification() {
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      const reg = await navigator.serviceWorker.getRegistration(SW_SCOPE);
      if (!reg) throw new Error("未找到通知服务，请重新开启提醒");
      await reg.showNotification("TeAms 测试通知", { body: "这条通知来自当前浏览器。", icon: "/icons/icon-192.png" });
      setNotice("浏览器已接受测试请求。若没有弹窗，请检查系统通知权限和专注模式。");
    } catch (e) {
      setError("本机测试失败 · " + (e instanceof Error ? e.message : "浏览器未能显示通知"));
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="rounded-lg bg-[#2b2d31] p-3" aria-label="通知" data-testid="push-settings">
      <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-[#b5bac1]">浏览器推送</div>
      {phase.kind === "unsupported" ? (
        <p className="text-sm text-[#f0b232]" role="status" data-testid="push-unsupported">
          ⚠ {phase.text}
        </p>
      ) : (
        <>
          <Switch isSelected={phase.on} isDisabled={pending} onChange={(v) => void toggle(v)} data-testid="push-switch">
            <Switch.Content className="gap-2">
              {/* 未选中轨道用 Discord 的灰 #4e5058，和卡片背景拉开对比；选中时的紫色轨道沿用主题 */}
              <Switch.Control className="[--switch-control-bg-hover:#5c5e66] [--switch-control-bg-pressed:#5c5e66] [--switch-control-bg:#4e5058]">
                <Switch.Thumb />
              </Switch.Control>
              <Label className="text-sm text-[#dbdee1]">开启频道消息通知</Label>
            </Switch.Content>
          </Switch>
          {phase.on && (
            <div className="mt-2 space-y-2">
              <p className="text-xs text-[#b5bac1]">{phase.subscribed ? "此浏览器有离线推送订阅。" : "仅在线提醒。离线推送未连接，请保持 TeAms 页面打开。"}</p>
              <div className="flex gap-2">
                <Button size="sm" variant="secondary" isDisabled={pending} onPress={() => void testNotification()}>测试本机通知</Button>
                <Button size="sm" variant="ghost" isDisabled={pending} onPress={() => void toggle(true)}>重新连接离线推送</Button>
              </div>
            </div>
          )}
          <details className="mt-2 text-xs text-[#b5bac1]">
            <summary className="cursor-pointer">本页在线提醒记录</summary>
            <pre className="mt-2 whitespace-pre-wrap">{log || "本页尚未记录收到的频道消息。"}</pre>
          </details>
          {phase.denied && !error ? (
            <p className="mt-2 text-xs text-[#f0b232]" data-testid="push-denied">
              通知权限已被拒绝。请点击地址栏左侧的站点信息图标，把「通知」改为允许后再打开开关。
            </p>
          ) : null}
        </>
      )}
      {error ? (
        <div className="mt-2" data-testid="push-error">
          <FormError>{error}</FormError>
        </div>
      ) : null}
      {notice ? <p className="mt-2 text-xs text-[#57f287]">{notice}</p> : null}
      {/* 错误提示里已带 Chrome 国内提示时不再重复 */}
      <p className="mt-2 text-[11px] leading-snug text-[#949ba4]">已加入的 Team 有新频道消息时提醒，包括你正在查看的频道。{error?.includes(CHROME_GFW_HINT) ? "" : CHROME_GFW_HINT}</p>
    </section>
  );
}
