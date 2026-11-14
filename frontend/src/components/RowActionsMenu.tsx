import { Dropdown, Label } from "@heroui/react";

export interface RowAction {
  id: string;
  text: string;
  danger?: boolean;
}

/**
 * 列表行的「⋯」菜单（成员列表、频道列表共用，HeroUI Dropdown）：
 * - 桌面端悬停 / 键盘聚焦行时才显示，触屏（pointer: coarse 或 hover: none）一直显示；
 * - 菜单紧凑（单项不高于一行），贴着「⋯」弹出、与按钮垂直居中，不压住相邻行；
 * - 危险项用 danger 变体 + Label（HeroUI 只给 [data-slot=label] 上红色），悬停/聚焦仍是红字。
 * 行本身要带 `group` class；右键打开由调用方控制 open。
 */
export function RowActionsMenu({
  label,
  actions,
  open,
  onOpenChange,
  onAction,
  disabled,
  placement = "left",
}: {
  label: string;
  actions: RowAction[];
  open: boolean;
  onOpenChange(open: boolean): void;
  onAction(id: string): void;
  disabled?: boolean;
  placement?: "left" | "right";
}) {
  if (actions.length === 0) return null;
  // key：菜单项集合变化（角色/权限变化）时换新实例，避免 React Aria 在退出动画中报 "Cannot change the id of an item"
  const key = actions.map((a) => a.id).join("|");
  return (
    <Dropdown key={key} isOpen={open} onOpenChange={onOpenChange}>
      <Dropdown.Trigger
        aria-label={label}
        data-testid="row-actions"
        isDisabled={disabled}
        className={`ml-auto flex h-6 w-6 shrink-0 items-center justify-center rounded text-[#b5bac1] outline-none hover:bg-[#404249] hover:text-white focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-brand ${
          open
            ? "opacity-100"
            : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100 [@media(hover:none)]:opacity-100"
        }`}
      >
        ⋯
      </Dropdown.Trigger>
      <Dropdown.Popover placement={placement} offset={6} className="min-w-36">
        <Dropdown.Menu className="p-1" aria-label={label} onAction={(k) => onAction(String(k))}>
          {actions.map((a) => (
            <Dropdown.Item key={a.id} id={a.id} className="min-h-8" textValue={a.text} variant={a.danger ? "danger" : "default"}>
              <Label className={a.danger ? "text-danger" : undefined}>{a.text}</Label>
            </Dropdown.Item>
          ))}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}
