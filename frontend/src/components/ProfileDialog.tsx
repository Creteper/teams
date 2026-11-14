import { useState } from "react";
import { Button, Input } from "@heroui/react";
import { useAuth } from "../auth/AuthContext";
import { charCount } from "../lib/text";
import { Field, FormError } from "./FormField";
import { Counter } from "./TeamSettingsDialog";
import { DialogShell } from "./ui";

const NAME_MAX = 64;

/** 编辑个人资料：PATCH /me {display_name}（1–64 字），成功后后端推 member.updated */
export function ProfileDialog({ onClose }: { onClose(): void }) {
  const { user, updateProfile } = useAuth();
  const [name, setName] = useState(user?.display_name ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const n = charCount(name.trim());
  const invalid = n < 1 ? "显示名称不能为空" : n > NAME_MAX ? `显示名称最多 ${NAME_MAX} 个字` : null;

  async function save() {
    if (invalid) return setError(invalid);
    setPending(true);
    setError(null);
    try {
      await updateProfile(name.trim());
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(false);
    }
  }

  return (
    <DialogShell label="编辑个人资料" title="编辑个人资料" onClose={onClose} width="max-w-md">
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Field id="profile-username" label="用户名" hint="用户名不能修改">
          <Input id="profile-username" value={`@${user?.username ?? ""}`} disabled />
        </Field>
        <Field id="profile-name" label={<span className="flex justify-between">显示名称 <Counter n={n} max={NAME_MAX} /></span>}>
          <Input id="profile-name" value={name} placeholder="别人看到的名字" autoFocus onChange={(e) => setName(e.target.value)} />
        </Field>
        {error ? <FormError>{error}</FormError> : null}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onPress={onClose}>
            取消
          </Button>
          <Button type="submit" variant="primary" isPending={pending} isDisabled={!!invalid}>
            保存
          </Button>
        </div>
      </form>
    </DialogShell>
  );
}
