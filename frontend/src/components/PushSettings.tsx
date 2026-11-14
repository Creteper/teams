import { useEffect, useState } from "react";
import { Label, Switch } from "@heroui/react";
import { api } from "../api";
import {
  CHROME_GFW_HINT,
  currentPushState,
  detectPushSupport,
  disablePush,
  enablePush,
  pushErrorText,
  unsupportedText,
} from "../lib/push";
import { FormError } from "./FormField";

type Phase = { kind: "loading" } | { kind: "hidden" } | { kind: "unsupported"; text: string } | { kind: "ready"; on: boolean; denied: boolean };

/**
 * 「开启 @ 消息通知」开关（docs/api.md §9.4）：
 * - 服务器未配置推送（enabled=false）→ 整个入口不显示；
 * - 浏览器不支持 → 显示说明；
 * - 只有点开关时才请求通知权限。
 */
export function PushSettings({ token, userId }: { token: string; userId: string }) {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

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
        const st = await currentPushState(userId).catch(() => ({ on: false, permission: Notification.permission }));
        if (!cancelled) setPhase({ kind: "ready", on: st.on, denied: st.permission === "denied" });
      } catch {
        // 拿不到配置就不显示入口（不影响其他功能）
        if (!cancelled) setPhase({ kind: "hidden" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, userId]);

  if (phase.kind === "hidden" || phase.kind === "loading") return null;

  async function toggle(next: boolean) {
    if (!publicKey) return;
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      if (next) {
        await enablePush(api, token, userId, publicKey);
        setPhase({ kind: "ready", on: true, denied: false });
        setNotice("已开启：有人 @ 你时，即使关掉网页也会收到通知。");
      } else {
        await disablePush(api, token);
        setPhase({ kind: "ready", on: false, denied: false });
        setNotice("已关闭 @ 消息通知。");
      }
    } catch (e) {
      setError(pushErrorText(e));
      if (Notification.permission === "denied") setPhase({ kind: "ready", on: false, denied: true });
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="mb-5 rounded-lg bg-[#2b2d31] p-3" aria-label="通知" data-testid="push-settings">
      <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-[#b5bac1]">通知</div>
      {phase.kind === "unsupported" ? (
        <p className="text-sm text-[#f0b232]" role="status" data-testid="push-unsupported">
          ⚠ {phase.text}
        </p>
      ) : (
        <>
          <Switch isSelected={phase.on} isDisabled={pending} onChange={(v) => void toggle(v)} data-testid="push-switch">
            <Switch.Content>
              <Switch.Control>
                <Switch.Thumb />
              </Switch.Control>
              <Label className="text-sm text-[#dbdee1]">开启 @ 消息通知</Label>
            </Switch.Content>
          </Switch>
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
      <p className="mt-2 text-[11px] leading-snug text-[#949ba4]">只在有人 @ 你时通知。{error?.includes(CHROME_GFW_HINT) ? "" : CHROME_GFW_HINT}</p>
    </section>
  );
}
