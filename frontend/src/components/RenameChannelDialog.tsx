import { useState } from "react";
import { Button, Input } from "@heroui/react";
import type { Channel } from "../api/types";
import { CHANNEL_NAME_MAX, channelErrorText, channelNameError } from "../lib/channels";
import { charCount } from "../lib/text";
import { Field } from "./FormField";
import { Counter } from "./TeamSettingsDialog";
import { DialogShell } from "./ui";

/** 频道改名弹窗：PATCH /channels/{id} {name}；本地校验 1–64 字符和同名，服务端 409/403 给中文提示 */
export function RenameChannelDialog({
  channel,
  channels,
  onSubmit,
  onClose,
}: {
  channel: Channel;
  channels: Channel[];
  onSubmit(name: string): Promise<void>;
  onClose(): void;
}) {
  const [name, setName] = useState(channel.name);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 用户改过输入后才显示本地校验结果：刚打开、还没动时不标红 */
  const [dirty, setDirty] = useState(false);
  const local = channelNameError(name, channels, channel.id);
  /** 输入框下方的原因：服务端/提交错误优先，其次是本地校验 */
  const fieldError = error ?? (dirty ? local : null);
  const unchanged = name.trim() === channel.name;

  async function save() {
    if (local) {
      setDirty(true);
      return;
    }
    if (unchanged) return onClose();
    setPending(true);
    setError(null);
    try {
      await onSubmit(name.trim());
      onClose();
    } catch (e) {
      setError(channelErrorText(e, "rename"));
    } finally {
      setPending(false);
    }
  }

  return (
    <DialogShell label="频道改名" title={`频道改名`} onClose={onClose} width="max-w-md">
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Field
          id="channel-name"
          invalid={!!fieldError}
          label={
            <span className="flex justify-between">
              频道名 <Counter n={charCount(name.trim())} max={CHANNEL_NAME_MAX} />
            </span>
          }
          hint={`当前：#${channel.name}`}
        >
          <Input
            id="channel-name"
            value={name}
            autoFocus
            aria-invalid={fieldError ? true : undefined}
            aria-describedby={fieldError ? "channel-name-error" : undefined}
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => {
              setName(e.target.value);
              setDirty(true);
              setError(null);
            }}
          />
          {fieldError ? (
            <p id="channel-name-error" role="alert" data-testid="channel-name-error" className="flex items-center gap-1 text-xs text-danger">
              <span aria-hidden="true">⚠</span>
              {fieldError}
            </p>
          ) : null}
        </Field>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onPress={onClose}>
            取消
          </Button>
          <Button type="submit" variant="primary" isPending={pending} isDisabled={!!local}>
            保存
          </Button>
        </div>
      </form>
    </DialogShell>
  );
}
