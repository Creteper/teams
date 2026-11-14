import { useState } from "react";
import { Button, Input } from "@heroui/react";
import type { Channel } from "../api/types";
import { CHANNEL_NAME_MAX, channelErrorText, channelNameError } from "../lib/channels";
import { charCount } from "../lib/text";
import { Field, FormError } from "./FormField";
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
  const local = channelNameError(name, channels, channel.id);
  const unchanged = name.trim() === channel.name;

  async function save() {
    if (local) return setError(local);
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
          invalid={!!error}
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
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
            }}
          />
        </Field>
        {error ? <FormError>{error}</FormError> : null}
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
