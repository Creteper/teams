import { useEffect, useRef, type ReactNode } from "react";
import { Button } from "@heroui/react";

/** 通用弹窗外壳（点遮罩 / Esc 关闭） */
export function DialogShell({
  label,
  title,
  onClose,
  children,
  width = "max-w-lg",
}: {
  label: string;
  title: ReactNode;
  onClose(): void;
  children: ReactNode;
  width?: string;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={label}
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/70 p-6"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={`max-h-full w-full ${width} overflow-y-auto rounded-xl bg-[#313338] p-6 text-[#dbdee1] shadow-2xl`}>
        <div className="mb-4 flex items-center justify-between gap-4">
          <h2 className="text-xl font-bold text-white">{title}</h2>
          <button type="button" aria-label="关闭" onClick={onClose} className="text-2xl leading-none text-[#b5bac1] hover:text-white">
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** 二次确认 */
export function ConfirmDialog({
  title,
  message,
  confirmText,
  danger = true,
  pending = false,
  error,
  onConfirm,
  onCancel,
}: {
  title: string;
  message: ReactNode;
  confirmText: string;
  danger?: boolean;
  pending?: boolean;
  error?: string | null;
  onConfirm(): void;
  onCancel(): void;
}) {
  return (
    <DialogShell label={title} title={title} onClose={onCancel} width="max-w-md">
      <div className="text-sm leading-relaxed text-[#b5bac1]">{message}</div>
      {error ? <p className="mt-3 text-sm text-[#f23f43]">{error}</p> : null}
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="ghost" onPress={onCancel}>
          取消
        </Button>
        <Button variant={danger ? "danger" : "primary"} isPending={pending} onPress={onConfirm}>
          {confirmText}
        </Button>
      </div>
    </DialogShell>
  );
}

/** 弹出菜单：点外部 / Esc 关闭 */
export function PopMenu({
  open,
  onClose,
  className,
  children,
  label,
}: {
  open: boolean;
  onClose(): void;
  className: string;
  children: ReactNode;
  label: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    // 延迟注册，避免打开菜单的那次点击立刻关闭它
    const t = setTimeout(() => document.addEventListener("mousedown", onDown));
    window.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(t);
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div ref={ref} role="menu" aria-label={label} className={`z-30 rounded-md bg-[#111214] p-1.5 shadow-xl ring-1 ring-black/50 ${className}`}>
      {children}
    </div>
  );
}

export function MenuItem({
  children,
  onSelect,
  danger,
  disabled,
  hint,
}: {
  children: ReactNode;
  onSelect?(): void;
  danger?: boolean;
  disabled?: boolean;
  hint?: string;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      title={hint}
      onClick={onSelect}
      className={`flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-sm disabled:cursor-not-allowed disabled:opacity-40 ${
        danger
          ? "text-[#f23f43] enabled:hover:bg-[#f23f43] enabled:hover:text-white"
          : "text-[#dbdee1] enabled:hover:bg-brand enabled:hover:text-white"
      }`}
    >
      {children}
    </button>
  );
}

/** 悬停提示（右侧气泡），用于 team 图标栏 */
export function RailTooltip({ text }: { text: string }) {
  return (
    <span
      role="tooltip"
      className="pointer-events-none absolute left-[64px] top-1/2 z-50 hidden -translate-y-1/2 whitespace-nowrap rounded-md bg-[#111214] px-3 py-2 text-sm font-semibold text-white shadow-lg group-hover:block group-focus-within:block"
    >
      <span className="absolute -left-1 top-1/2 h-2 w-2 -translate-y-1/2 rotate-45 bg-[#111214]" />
      {text}
    </span>
  );
}

export function GearIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
    </svg>
  );
}

export function CrownIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="#f0b232" aria-label="所有者" role="img">
      <path d="M3 7l4.5 4L12 4l4.5 7L21 7l-2 12H5L3 7Z" />
    </svg>
  );
}

export function EyeIcon({ off = false }: { off?: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
      <circle cx="12" cy="12" r="3" />
      {off ? <path d="M3 3l18 18" /> : null}
    </svg>
  );
}
