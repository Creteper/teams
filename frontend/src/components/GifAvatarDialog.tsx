import { useEffect, useState } from "react";
import { Button } from "@heroui/react";
import { formatBytes } from "../lib/avatarCrop";
import { FormError } from "./FormField";
import { DialogShell } from "./ui";

/**
 * GIF 头像：不裁剪、不转码（转 PNG 会丢动画），原文件直接 PUT /me/avatar。
 * 预览用 <img>（不画到 canvas），object-fit: cover 居中裁成方形——和所有显示头像的地方一致。
 */
export function GifAvatarDialog({
  file,
  size,
  onCancel,
  onConfirm,
}: {
  file: File;
  size: { width: number; height: number };
  onCancel(): void;
  onConfirm(): Promise<void>;
}) {
  const [url, setUrl] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);

  async function confirm() {
    setPending(true);
    setError(null);
    try {
      await onConfirm();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(false);
    }
  }

  return (
    <DialogShell label="预览动图头像" title="预览动图头像" onClose={onCancel} width="max-w-md">
      <div className="flex items-center gap-6" data-testid="gif-avatar-preview">
        {url ? (
          <img
            src={url}
            alt="动图头像预览（大）"
            data-testid="gif-preview-large"
            className="h-40 w-40 shrink-0 rounded-full object-cover object-center ring-2 ring-white/20"
          />
        ) : (
          <div className="h-40 w-40 shrink-0 rounded-full bg-[#1e1f22]" />
        )}
        <div className="flex items-end gap-4" data-testid="gif-preview-small">
          {url ? (
            <>
              <img src={url} alt="动图头像预览（中）" className="h-16 w-16 rounded-full object-cover object-center" />
              <img src={url} alt="动图头像预览（小）" className="h-8 w-8 rounded-full object-cover object-center" />
            </>
          ) : null}
        </div>
      </div>
      <p className="mt-4 rounded-md bg-[#f0b232]/10 px-3 py-2 text-sm text-[#f0b232]" data-testid="gif-center-hint">
        动图会居中裁切显示
      </p>
      <p className="mt-2 text-xs text-[#949ba4]">
        GIF 会按原文件上传以保留动画（{size.width}×{size.height}，{formatBytes(file.size)}），不能在这里裁剪。
      </p>
      {error ? (
        <div className="mt-3">
          <FormError>{error}</FormError>
        </div>
      ) : null}
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onPress={onCancel}>
          取消
        </Button>
        <Button variant="primary" isPending={pending} onPress={() => void confirm()}>
          使用这个动图
        </Button>
      </div>
    </DialogShell>
  );
}
