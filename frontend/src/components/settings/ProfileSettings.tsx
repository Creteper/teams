import { useRef, useState } from "react";
import { Button, Card, Input } from "@heroui/react";
import { useAuth } from "../../auth/AuthContext";
import { avatarDimError, avatarFileError, avatarUploadErrorText, gifSize, sniffImage } from "../../lib/avatarCrop";
import { charCount } from "../../lib/text";
import { AvatarCropDialog } from "../AvatarCropDialog";
import { GifAvatarDialog } from "../GifAvatarDialog";
import { Field, FormError } from "../FormField";
import { MemberAvatar } from "../MemberAvatar";
import { Counter } from "../TeamSettingsDialog";
import { ConfirmDialog } from "../ui";

const NAME_MAX = 64;

/**
 * 设置 → 个人资料（原「编辑个人资料」弹窗的内容，并入设置窗口）：
 * - 头像：PUT /me/avatar（选图 → 校验类型/大小 → 裁剪成正方形 → 上传）、DELETE /me/avatar（二次确认）；
 *   GIF 不裁剪不转码，原文件上传以保留动画（先读文件头检查 ≤ 4096×4096），显示时 object-fit: cover 居中裁切；
 * （@ 消息通知开关移到了设置 →「通知」）
 * - 显示名称：PATCH /me {display_name}（1–64 字）。
 * 成功后后端向所在 team 推 member.updated，其他窗口随之更新。
 */
export function ProfileSettings() {
  const { user, updateProfile, uploadAvatar, removeAvatar } = useAuth();
  const [gif, setGif] = useState<{ file: File; size: { width: number; height: number } } | null>(null);
  const [name, setName] = useState(user?.display_name ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const [avatarNotice, setAvatarNotice] = useState<string | null>(null);
  const [cropping, setCropping] = useState<{ file: File; type: string } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [removing, setRemoving] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const n = charCount(name.trim());
  const dirty = name.trim() !== (user?.display_name ?? "");
  const invalid = n < 1 ? "显示名称不能为空" : n > NAME_MAX ? `显示名称最多 ${NAME_MAX} 个字` : null;

  async function save() {
    if (invalid) return setError(invalid);
    setPending(true);
    setError(null);
    setSaved(false);
    try {
      if (dirty) await updateProfile(name.trim());
      setName(name.trim());
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(false);
    }
  }

  async function pick(file: File | undefined) {
    setAvatarError(null);
    setAvatarNotice(null);
    if (!file) return;
    const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
    const type = sniffImage(head);
    const bad = avatarFileError(file.size, type);
    if (bad) return setAvatarError(bad);
    if (type === "image/gif") {
      // 动图：原文件直传，后端不缩放、超过 4096 直接拒绝，所以先在本地看尺寸
      const size = gifSize(head);
      if (!size) return setAvatarError("图片无法读取，可能已损坏，请换一张");
      const tooBig = avatarDimError(size.width, size.height);
      if (tooBig) return setAvatarError(tooBig);
      return setGif({ file, size });
    }
    setCropping({ file, type: type! });
  }

  return (
    <div className="flex flex-col gap-4">
      <Card className="flex-row items-center gap-4 rounded-lg bg-[#2b2d31] p-4 shadow-none" aria-label="头像" role="group">
        {user ? <MemberAvatar member={user} size={72} /> : null}
        <div className="flex flex-1 flex-col gap-2">
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="primary" onPress={() => fileRef.current?.click()}>
              {user?.avatar_url ? "更换头像" : "上传头像"}
            </Button>
            {user?.avatar_url ? (
              <Button size="sm" variant="danger-soft" onPress={() => setConfirmRemove(true)}>
                移除头像
              </Button>
            ) : null}
          </div>
          <p className="text-xs text-[#949ba4]">支持 jpg、png、gif、webp，不超过 5 MB；静态图上传前可裁剪成正方形，GIF 保留动画、居中裁切显示。</p>
          <input
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/png,image/gif,image/webp"
            className="hidden"
            data-testid="avatar-file-input"
            onChange={(e) => {
              void pick(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
          {avatarError ? <FormError>{avatarError}</FormError> : null}
          {avatarNotice ? <p className="text-xs text-[#57f287]">{avatarNotice}</p> : null}
        </div>
      </Card>
      <Card className="rounded-lg bg-[#2b2d31] p-4 shadow-none">
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
          <Input
            id="profile-name"
            value={name}
            placeholder="别人看到的名字"
            onChange={(e) => {
              setName(e.target.value);
              setSaved(false);
            }}
          />
        </Field>
        {error ? <FormError>{error}</FormError> : null}
        <div className="flex items-center justify-end gap-2">
          {saved && !dirty ? (
            <span className="mr-auto text-xs text-[#57f287]" role="status">
              已保存
            </span>
          ) : null}
          <Button variant="ghost" isDisabled={!dirty} onPress={() => setName(user?.display_name ?? "")}>
            撤销
          </Button>
          <Button type="submit" variant="primary" isPending={pending} isDisabled={!!invalid || !dirty}>
            保存
          </Button>
        </div>
      </form>
      </Card>

      {cropping ? (
        <AvatarCropDialog
          file={cropping.file}
          sniffedType={cropping.type}
          onCancel={() => setCropping(null)}
          onConfirm={async (blob, filename) => {
            try {
              await uploadAvatar(blob, filename);
            } catch (e) {
              throw new Error(`上传失败：${avatarUploadErrorText(e)}`);
            }
            setCropping(null);
            setAvatarNotice("头像已更新");
          }}
        />
      ) : null}
      {gif ? (
        <GifAvatarDialog
          file={gif.file}
          size={gif.size}
          onCancel={() => setGif(null)}
          onConfirm={async () => {
            try {
              await uploadAvatar(gif.file, gif.file.name || "avatar.gif");
            } catch (e) {
              throw new Error(`上传失败：${avatarUploadErrorText(e)}`);
            }
            setGif(null);
            setAvatarNotice("头像已更新（动图）");
          }}
        />
      ) : null}
      {confirmRemove ? (
        <ConfirmDialog
          title="移除头像"
          message={<>确定要移除头像吗？移除后会显示名字首字母。</>}
          confirmText="移除头像"
          pending={removing}
          error={avatarError}
          onConfirm={async () => {
            setRemoving(true);
            setAvatarError(null);
            try {
              await removeAvatar();
              setConfirmRemove(false);
              setAvatarNotice("头像已移除");
            } catch (e) {
              setAvatarError(`移除失败：${e instanceof Error ? e.message : String(e)}`);
            } finally {
              setRemoving(false);
            }
          }}
          onCancel={() => setConfirmRemove(false)}
        />
      ) : null}
    </div>
  );
}
