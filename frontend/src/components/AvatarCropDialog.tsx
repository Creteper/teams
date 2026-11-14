import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type WheelEvent } from "react";
import { Button } from "@heroui/react";
import {
  AVATAR_MAX_BYTES,
  MAX_ZOOM,
  clampCrop,
  formatBytes,
  initialCrop,
  outputSize,
  outputType,
  sourceRect,
  zoomAt,
  type CropState,
} from "../lib/avatarCrop";
import { FormError } from "./FormField";
import { DialogShell } from "./ui";

const VIEW = 280;

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/** 把裁剪区域画到 size×size 的 canvas 上 */
function draw(canvas: HTMLCanvasElement, img: HTMLImageElement, s: CropState, size: number, jpeg: boolean) {
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const r = sourceRect(s, img.naturalWidth, img.naturalHeight, VIEW);
  ctx.imageSmoothingQuality = "high";
  if (jpeg) {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, size, size);
  } else ctx.clearRect(0, 0, size, size);
  ctx.drawImage(img, r.sx, r.sy, r.size, r.size, 0, 0, size, size);
}

/**
 * 头像裁剪（纯 canvas，无第三方依赖）：正方形取景框（圆形遮罩只是示意，上传的是正方形）、
 * 拖动平移、滚轮 / 滑杆 / 键盘（方向键平移，+/- 缩放）缩放，右侧实时预览。
 * 确认后输出 ≤512×512 的 png（jpeg 源输出 jpeg），保证在 5 MB 以内再交给 onConfirm 上传。
 */
export function AvatarCropDialog({
  file,
  sniffedType,
  onConfirm,
  onCancel,
}: {
  file: File;
  sniffedType: string;
  onConfirm(blob: Blob, filename: string): Promise<void>;
  onCancel(): void;
}) {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [url, setUrl] = useState<string>("");
  const [crop, setCrop] = useState<CropState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [outInfo, setOutInfo] = useState<string>("");
  const drag = useRef<{ id: number; x: number; y: number; start: CropState } | null>(null);
  const bigPreview = useRef<HTMLCanvasElement>(null);
  const smallPreview = useRef<HTMLCanvasElement>(null);
  const type = outputType(sniffedType);

  useEffect(() => {
    const u = URL.createObjectURL(file);
    setUrl(u);
    // StrictMode 下 effect 会先清理再重跑：清理时 revoke 掉的旧 URL 会让旧 Image 触发 onerror，必须忽略。
    let alive = true;
    const image = new Image();
    image.onload = () => {
      if (!alive) return;
      setError(null);
      setImg(image);
      setCrop(initialCrop(image.naturalWidth, image.naturalHeight, VIEW));
    };
    image.onerror = () => {
      if (alive) setError("图片无法读取，可能已损坏，请换一张");
    };
    image.src = u;
    return () => {
      alive = false;
      image.onload = null;
      image.onerror = null;
      URL.revokeObjectURL(u);
    };
  }, [file]);

  const set = useCallback(
    (next: CropState) => {
      if (img) setCrop(clampCrop(next, img.naturalWidth, img.naturalHeight, VIEW));
    },
    [img],
  );

  // 预览
  useEffect(() => {
    if (!img || !crop) return;
    if (bigPreview.current) draw(bigPreview.current, img, crop, 192, type === "image/jpeg");
    if (smallPreview.current) draw(smallPreview.current, img, crop, 80, type === "image/jpeg");
    const r = sourceRect(crop, img.naturalWidth, img.naturalHeight, VIEW);
    const n = outputSize(r.size);
    setOutInfo(`输出 ${n}×${n} ${type === "image/jpeg" ? "JPG" : "PNG"}`);
  }, [img, crop, type]);

  function onPointerDown(e: PointerEvent<HTMLDivElement>) {
    if (!crop) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, start: crop };
  }
  function onPointerMove(e: PointerEvent<HTMLDivElement>) {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    set({ ...d.start, x: d.start.x + e.clientX - d.x, y: d.start.y + e.clientY - d.y });
  }
  function onPointerUp(e: PointerEvent<HTMLDivElement>) {
    if (drag.current?.id === e.pointerId) drag.current = null;
  }
  function onWheel(e: WheelEvent<HTMLDivElement>) {
    if (!img || !crop) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const z = crop.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1);
    setCrop(zoomAt(crop, z, e.clientX - rect.left, e.clientY - rect.top, img.naturalWidth, img.naturalHeight, VIEW));
  }
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (!img || !crop) return;
    const step = e.shiftKey ? 30 : 10;
    const moves: Record<string, [number, number]> = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    if (moves[e.key]) {
      e.preventDefault();
      set({ ...crop, x: crop.x + moves[e.key][0], y: crop.y + moves[e.key][1] });
    } else if (e.key === "+" || e.key === "=" || e.key === "-") {
      e.preventDefault();
      const z = crop.zoom * (e.key === "-" ? 1 / 1.1 : 1.1);
      setCrop(zoomAt(crop, z, VIEW / 2, VIEW / 2, img.naturalWidth, img.naturalHeight, VIEW));
    }
  }

  async function confirm() {
    if (!img || !crop) return;
    setPending(true);
    setError(null);
    try {
      const r = sourceRect(crop, img.naturalWidth, img.naturalHeight, VIEW);
      const canvas = document.createElement("canvas");
      let size = outputSize(r.size);
      draw(canvas, img, crop, size, type === "image/jpeg");
      let blob = await toBlob(canvas, type, 0.92);
      // 兜底：理论上 512² 不会超过 5 MB；万一超了，逐步缩小再试
      while (blob && blob.size > AVATAR_MAX_BYTES && size > 128) {
        size = Math.round(size * 0.75);
        draw(canvas, img, crop, size, type === "image/jpeg");
        blob = await toBlob(canvas, type, 0.85);
      }
      if (!blob) throw new Error("浏览器无法导出图片");
      if (blob.size > AVATAR_MAX_BYTES) throw new Error(`裁剪后的图片仍超过 5 MB（${formatBytes(blob.size)}），请换一张`);
      await onConfirm(blob, type === "image/jpeg" ? "avatar.jpg" : "avatar.png");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(false);
    }
  }

  const scale = img && crop ? (VIEW / Math.min(img.naturalWidth, img.naturalHeight)) * crop.zoom : 1;

  return (
    <DialogShell label="裁剪头像" title="裁剪头像" onClose={onCancel} width="max-w-xl">
      <div className="flex flex-col gap-5 sm:flex-row">
        <div className="flex flex-col items-center gap-3">
          <div
            role="application"
            aria-label="头像取景框：拖动平移，滚轮或 +/- 缩放，方向键微调"
            tabIndex={0}
            data-testid="avatar-crop-view"
            className="relative cursor-grab touch-none select-none overflow-hidden rounded-lg bg-[#1e1f22] outline-none focus-visible:ring-2 focus-visible:ring-brand active:cursor-grabbing"
            style={{ width: VIEW, height: VIEW }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onWheel={onWheel}
            onKeyDown={onKeyDown}
          >
            {img && crop ? (
              <img
                src={url}
                alt=""
                draggable={false}
                className="pointer-events-none absolute left-0 top-0 max-w-none"
                style={{ width: img.naturalWidth * scale, height: img.naturalHeight * scale, transform: `translate(${crop.x}px, ${crop.y}px)` }}
              />
            ) : null}
            {/* 圆形示意：外面压暗（上传的是整个正方形） */}
            <div className="pointer-events-none absolute inset-0 rounded-full shadow-[0_0_0_9999px_rgba(0,0,0,0.55)] ring-2 ring-white/70" />
          </div>
          <label className="flex w-full items-center gap-2 text-xs text-[#b5bac1]">
            <span>缩放</span>
            <input
              type="range"
              aria-label="缩放"
              min={1}
              max={MAX_ZOOM}
              step={0.01}
              value={crop?.zoom ?? 1}
              disabled={!img}
              onChange={(e) => img && crop && setCrop(zoomAt(crop, Number(e.target.value), VIEW / 2, VIEW / 2, img.naturalWidth, img.naturalHeight, VIEW))}
              className="flex-1 accent-[#6d5cf6]"
            />
            <span className="w-10 text-right tabular-nums">{(crop?.zoom ?? 1).toFixed(1)}×</span>
          </label>
        </div>
        <div className="flex flex-1 flex-col gap-3">
          <div className="text-sm font-semibold text-[#f2f3f5]">预览</div>
          <div className="flex items-end gap-4" data-testid="avatar-crop-preview">
            <canvas ref={bigPreview} aria-label="大尺寸预览" className="h-24 w-24 rounded-full bg-[#1e1f22]" />
            <canvas ref={smallPreview} aria-label="小尺寸预览" className="h-10 w-10 rounded-full bg-[#1e1f22]" />
          </div>
          <p className="text-xs leading-relaxed text-[#949ba4]">
            {outInfo}
            {sniffedType === "image/gif" ? "；GIF 动图只保留当前帧" : ""}
            <br />
            原图 {formatBytes(file.size)}
            {img ? ` · ${img.naturalWidth}×${img.naturalHeight}` : ""}
          </p>
          {error ? <FormError>{error}</FormError> : null}
        </div>
      </div>
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="ghost" onPress={onCancel}>
          取消
        </Button>
        <Button variant="primary" isPending={pending} isDisabled={!img} onPress={() => void confirm()}>
          使用这个头像
        </Button>
      </div>
    </DialogShell>
  );
}
