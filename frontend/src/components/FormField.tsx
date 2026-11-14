import { useState, type ReactNode } from "react";
import { Input, Label, TextField, ToggleButton } from "@heroui/react";
import { EyeIcon } from "./ui";

/** 表单字段：标签 + 输入 + 说明，统一间距；invalid 时用 HeroUI TextField 的 invalid 状态给输入框标红 */
export function Field({
  id,
  label,
  hint,
  invalid = false,
  children,
}: {
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  invalid?: boolean;
  children: ReactNode;
}) {
  return (
    <TextField isInvalid={invalid} className="flex flex-col gap-1.5" data-field={id}>
      <Label htmlFor={id} className="text-xs font-semibold uppercase tracking-wide text-[#b5bac1]">
        {label}
      </Label>
      {children}
      {hint ? <p className="text-xs text-[#949ba4]">{hint}</p> : null}
    </TextField>
  );
}

/** 密码输入：可切换显示/隐藏 */
export function PasswordInput({
  id,
  value,
  onChange,
  placeholder,
  autoComplete,
}: {
  id: string;
  value: string;
  onChange(v: string): void;
  placeholder?: string;
  autoComplete?: string;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <Input
        id={id}
        type={show ? "text" : "password"}
        autoComplete={autoComplete}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full pr-10"
      />
      <ToggleButton
        isIconOnly
        aria-label={show ? "隐藏密码" : "显示密码"}
        isSelected={show}
        onChange={setShow}
        className="absolute top-1/2 right-2 size-7 min-w-7 -translate-y-1/2 rounded bg-transparent text-[#949ba4] hover:bg-transparent hover:text-white data-[hovered=true]:bg-transparent data-[selected=true]:bg-transparent data-[selected=true]:text-[#949ba4] data-[pressed=true]:scale-100"
      >
        <EyeIcon off={show} />
      </ToggleButton>
    </div>
  );
}

export function FormError({ children }: { children: ReactNode }) {
  return (
    <div role="alert" className="flex items-start gap-2 rounded-md border border-[#f23f43]/40 bg-[#f23f43]/10 px-3 py-2 text-sm text-[#ff8a8c]">
      <span aria-hidden="true">⚠</span>
      <span>{children}</span>
    </div>
  );
}
