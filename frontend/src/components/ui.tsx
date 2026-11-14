import type { ReactElement, ReactNode } from "react";
import { AlertDialog, Button, Modal, Tooltip } from "@heroui/react";

/**
 * 通用弹窗外壳（HeroUI Modal）：点遮罩 / Esc 关闭（Esc 只关最上层；下拉框打开时 Esc 先收起下拉框，
 * 都由 React Aria 的 overlay 栈处理），焦点锁在弹窗内、关闭后还给打开它的元素。
 * 视觉沿用原来的 Discord 深色：#313338 圆角 12px 卡片、70% 黑遮罩、右上角 ×。
 */
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
  return (
    <Modal.Backdrop
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      className="z-40 bg-black/70"
    >
      <Modal.Container placement="center" scroll="inside" className="w-full p-6 sm:w-full sm:p-6">
        <Modal.Dialog aria-label={label} className={`${width} rounded-xl bg-[#313338] p-6 text-[#dbdee1] shadow-2xl`}>
          <Modal.Header className="mb-4 flex-row items-center justify-between gap-4">
            <Modal.Heading className="text-xl font-bold text-white">{title}</Modal.Heading>
          </Modal.Header>
          <Modal.CloseTrigger aria-label="关闭" className={CLOSE_BUTTON_CLASS} />
          <Modal.Body className="m-0 mt-0 p-0 text-base leading-normal text-inherit">{children}</Modal.Body>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}

/** 弹窗右上角 ×：HeroUI CloseButton 去掉底色，灰色、悬停变白（和原来一致） */
export const CLOSE_BUTTON_CLASS =
  "absolute right-5 top-6 h-7 w-7 min-w-7 rounded bg-transparent text-[#b5bac1] hover:bg-transparent hover:text-white data-[hovered=true]:bg-transparent [&_svg]:size-5";

/** 二次确认（HeroUI AlertDialog） */
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
    <AlertDialog.Backdrop
      isOpen
      // AlertDialog 默认不允许点遮罩 / Esc 关闭；这里保持原来的行为：两者都等于「取消」
      isDismissable
      isKeyboardDismissDisabled={false}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      className="z-40 bg-black/70"
    >
      <AlertDialog.Container placement="center" className="w-full p-6 sm:w-full sm:p-6">
        <AlertDialog.Dialog aria-label={title} className="max-w-md rounded-xl bg-[#313338] p-6 text-[#dbdee1] shadow-2xl">
          <AlertDialog.Header className="mb-4 flex-row items-center justify-between gap-4">
            <AlertDialog.Heading className="text-xl font-bold text-white">{title}</AlertDialog.Heading>
          </AlertDialog.Header>
          <AlertDialog.CloseTrigger aria-label="关闭" className={CLOSE_BUTTON_CLASS} />
          <AlertDialog.Body className="m-0 mt-0 p-0 text-sm leading-relaxed text-[#b5bac1]">
            {message}
            {error ? <p className="mt-3 text-sm text-[#f23f43]">{error}</p> : null}
          </AlertDialog.Body>
          <AlertDialog.Footer className="mt-6 flex justify-end gap-2">
            <Button variant="ghost" onPress={onCancel}>
              取消
            </Button>
            <Button variant={danger ? "danger" : "primary"} isPending={pending} onPress={onConfirm}>
              {confirmText}
            </Button>
          </AlertDialog.Footer>
        </AlertDialog.Dialog>
      </AlertDialog.Container>
    </AlertDialog.Backdrop>
  );
}

/**
 * 悬停 / 键盘聚焦时的提示（右侧气泡，HeroUI Tooltip），用于 team 图标栏。
 * 触发元素就是图标本身（render 回调里拿到 trigger props 交给 Link / Button），不额外包一层可聚焦的 div。
 */
export function RailTooltip({
  text,
  children,
}: {
  text: string;
  /** 函数：拿 trigger props 渲染 Link 等普通元素；ReactElement：HeroUI Button（自己接入 Tooltip 的触发上下文） */
  children: ((triggerProps: Record<string, unknown>) => ReactElement) | ReactElement;
}) {
  return (
    <Tooltip delay={0} closeDelay={0}>
      {typeof children === "function" ? (
        <Tooltip.Trigger
          render={(props) => {
            // Tooltip.Trigger 默认是 role=button 的 div：去掉 role / className，让子元素保持自己的语义和样式
            const { role: _role, className: _cls, ...rest } = props as Record<string, unknown>;
            return children(rest);
          }}
        />
      ) : (
        children
      )}
      <Tooltip.Content
        placement="right"
        offset={8}
        showArrow
        className="pointer-events-none rounded-md bg-[#111214] px-3 py-2 text-sm font-semibold whitespace-nowrap text-white shadow-lg"
      >
        <Tooltip.Arrow className="[&_path]:fill-[#111214]" />
        {text}
      </Tooltip.Content>
    </Tooltip>
  );
}

/** 「Team 设置」用的滑杆图标（齿轮留给用户设置） */
export function SlidersIcon({ size = 16, className = "" }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" className={className}>
      <path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0" />
      <circle cx="16" cy="6" r="2" />
      <circle cx="10" cy="12" r="2" />
      <circle cx="18" cy="18" r="2" />
    </svg>
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

/** 图钉（线性，和齿轮等图标同一风格；颜色跟随 currentColor） */
export function PinIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 17v5" />
      <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
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
