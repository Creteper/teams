import { useState, type ReactNode } from "react";
import { Button, ColorArea, ColorField, ColorPicker, ColorSlider, ColorSwatch, Popover } from "@heroui/react";
import type { IssueOption, IssueOptionKind } from "../../api/issues";
import { errorText } from "../../lib/errorText";
import { IssueIcon } from "./IssueIcon";

export const optionNames = { label: "标签", status: "状态" };
export function Dot({ color }: { color: string }) {
  return <span aria-hidden="true" className="inline-block size-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />;
}
export function PropertyMenu({ label, trigger, children }: {
  label: string; trigger: ReactNode; children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return <Popover isOpen={open} onOpenChange={setOpen}>
    <Button aria-label={label} size="sm" variant="secondary" className="issue-chip">{trigger}</Button>
    <Popover.Content isNonModal placement="bottom start" offset={6} className="issue-popover">
      <Popover.Dialog aria-label={label} className="p-0">{children(() => setOpen(false))}</Popover.Dialog>
    </Popover.Content>
  </Popover>;
}

export function NewOption({ kind, initialName = "", save }: {
  kind: IssueOptionKind; initialName?: string; save: (option: IssueOption) => Promise<void>;
}) {
  const [name, setName] = useState(initialName);
  const [color, setColor] = useState(kind === "label" ? "#50b7a1" : "#8b80f9");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit() {
    if (busy || !name.trim()) return;
    setBusy(true); setError("");
    try { await save({ kind, name: name.trim(), color }); setName(""); }
    catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  }
  const label = optionNames[kind];
  return <div className="flex flex-col gap-2">
    <div className="flex items-center gap-2">
      <ColorPicker defaultValue={color} onChange={value => setColor(value.toString("hex"))}>
        <ColorPicker.Trigger aria-label={label + "颜色"} className="size-7 justify-center">
          <ColorSwatch className="size-5 rounded" />
        </ColorPicker.Trigger>
        <ColorPicker.Popover data-issue-option-colors="" placement="bottom start" className="issue-popover">
          <Popover.Dialog aria-label={label + "颜色"} className="grid gap-3 p-1">
            <ColorArea colorSpace="hsb" xChannel="saturation" yChannel="brightness" aria-label="饱和度与亮度">
              <ColorArea.Thumb />
            </ColorArea>
            <ColorSlider colorSpace="hsb" channel="hue" aria-label="色相">
              <ColorSlider.Track><ColorSlider.Thumb /></ColorSlider.Track>
            </ColorSlider>
            <ColorField aria-label="十六进制颜色"><ColorField.Group><ColorField.Input /></ColorField.Group></ColorField>
          </Popover.Dialog>
        </ColorPicker.Popover>
      </ColorPicker>
      <input aria-label={label + "名称"} placeholder={label + "名称"} maxLength={48} className="issue-input min-w-0 flex-1" value={name} onChange={e => setName(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); void submit(); } }} />
      <button className="issue-action" type="button" disabled={busy || !name.trim()} onClick={() => void submit()}>创建</button>
    </div>
    {error && <p role="alert" className="issue-error">{error}</p>}
  </div>;
}

export function OptionMenuBody({ kind, options, selected, choose, save, closeAfterCreate }: {
  kind: IssueOptionKind; options: IssueOption[]; selected: string[]; choose: (option: IssueOption) => void;
  save: (option: IssueOption) => Promise<void>;
  closeAfterCreate?: () => void;
}) {
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const label = optionNames[kind];
  return <div className="w-60">
    <input aria-label={"搜索" + label} className="issue-input mb-2 w-full" placeholder={"搜索" + label + "…"} value={query} onChange={e => { setQuery(e.target.value); setCreating(false); }} />
    <div className="max-h-48 overflow-y-auto">
      {options.filter(o => o.kind === kind && o.name.toLowerCase().includes(query.trim().toLowerCase())).map(o =>
        <button type="button" className="issue-menu-row" key={o.name} aria-pressed={selected.includes(o.name)} onClick={() => choose(o)}>
          <Dot color={o.color} /><span className="flex-1 truncate text-left">{o.name}</span>{selected.includes(o.name) && <span aria-hidden="true">✓</span>}
        </button>)}
    </div>
    <div className="mt-1 border-t border-white/10 pt-2">
      {creating ? <NewOption kind={kind} initialName={query} save={async o => { await save(o); choose(o); setQuery(""); setCreating(false); closeAfterCreate?.(); }} /> :
        <button type="button" className="issue-menu-row text-brand-light" onClick={() => setCreating(true)}><IssueIcon name="plus" size={14} />创建{label}</button>}
    </div>
  </div>;
}
