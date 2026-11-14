import { errorText } from "./errorText";
/**
 * 用户头像（§10.1）：只接受 jpeg / png / gif / webp（服务端嗅探），≤ 5 MB，宽高 ≤ 4096；服务端不裁剪不缩放。
 * 前端先裁成正方形再上传。这里放纯函数（校验、嗅探、裁剪几何），canvas 绘制在 AvatarCropDialog 里。
 */
export const AVATAR_MAX_BYTES = 5 * 1024 * 1024;
export const AVATAR_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];
/** 输出边长：够清晰，体积远小于 5 MB，也远小于 4096 的上限 */
export const AVATAR_OUTPUT_SIZE = 512;

/** 按文件头判断图片类型（与服务端“嗅探”一致，不信任扩展名/MIME） */
export function sniffImage(b: Uint8Array): string | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a)
    return "image/png";
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61)
    return "image/gif";
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50)
    return "image/webp";
  return null;
}

/** 选文件后的校验：返回中文错误或 null；type 为嗅探结果 */
export function avatarFileError(size: number, sniffed: string | null): string | null {
  if (size === 0) return "文件是空的，请重新选择";
  if (!sniffed || !AVATAR_TYPES.includes(sniffed)) return "只支持 jpg、png、gif、webp 格式的图片";
  if (size > AVATAR_MAX_BYTES) return `图片不能超过 5 MB（当前 ${(size / 1024 / 1024).toFixed(2)} MB）`;
  return null;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 裁剪状态：正方形取景框边长 view（px），图片按 scale 缩放后放在 (x, y)（相对取景框左上角）。
 * zoom=1 时图片恰好铺满取景框（短边 = view），zoom ∈ [1, maxZoom]。
 */
export interface CropState {
  zoom: number;
  x: number;
  y: number;
}

export const MAX_ZOOM = 4;

export function baseScale(imgW: number, imgH: number, view: number): number {
  return view / Math.min(imgW, imgH);
}

/** 把位置夹到“图片始终盖满取景框”的范围内 */
export function clampCrop(s: CropState, imgW: number, imgH: number, view: number): CropState {
  const zoom = Math.min(MAX_ZOOM, Math.max(1, s.zoom));
  const scale = baseScale(imgW, imgH, view) * zoom;
  const w = imgW * scale;
  const h = imgH * scale;
  const x = Math.min(0, Math.max(view - w, s.x));
  const y = Math.min(0, Math.max(view - h, s.y));
  return { zoom, x, y };
}

/** 初始：铺满并居中 */
export function initialCrop(imgW: number, imgH: number, view: number): CropState {
  const scale = baseScale(imgW, imgH, view);
  return { zoom: 1, x: (view - imgW * scale) / 2, y: (view - imgH * scale) / 2 };
}

/** 以取景框内某点为中心缩放（滚轮/滑杆），保持该点下的图像内容不动 */
export function zoomAt(s: CropState, nextZoom: number, px: number, py: number, imgW: number, imgH: number, view: number): CropState {
  const z = Math.min(MAX_ZOOM, Math.max(1, nextZoom));
  const k = z / s.zoom;
  return clampCrop({ zoom: z, x: px - (px - s.x) * k, y: py - (py - s.y) * k }, imgW, imgH, view);
}

/** 取景框对应的原图正方形区域（源像素） */
export function sourceRect(s: CropState, imgW: number, imgH: number, view: number): { sx: number; sy: number; size: number } {
  const scale = baseScale(imgW, imgH, view) * s.zoom;
  const size = Math.min(view / scale, imgW, imgH);
  const sx = Math.min(Math.max(0, -s.x / scale), imgW - size);
  const sy = Math.min(Math.max(0, -s.y / scale), imgH - size);
  return { sx, sy, size };
}

/** 输出格式：有透明的（png/gif/webp）用 png；jpeg 用 jpeg。gif 只保留当前帧（动图会变静态） */
export function outputType(srcType: string): "image/png" | "image/jpeg" {
  return srcType === "image/jpeg" ? "image/jpeg" : "image/png";
}

/** 输出边长：不放大小图（源区域比 512 小就按源尺寸），至少 64 */
export function outputSize(srcRectSize: number): number {
  return Math.max(64, Math.min(AVATAR_OUTPUT_SIZE, Math.round(srcRectSize)));
}

/** 服务端上限：宽、高各 ≤ 4096，超过直接拒绝（400 field=avatar，§10.1） */
export const AVATAR_MAX_DIM = 4096;

/** GIF 逻辑屏幕尺寸：文件头第 6–9 字节（小端），不用解码整张图 */
export function gifSize(b: Uint8Array): { width: number; height: number } | null {
  if (b.length < 10 || sniffImage(b) !== "image/gif") return null;
  return { width: b[6] | (b[7] << 8), height: b[8] | (b[9] << 8) };
}

/** 原图直传（GIF）前的尺寸检查 */
export function avatarDimError(width: number, height: number): string | null {
  if (width > AVATAR_MAX_DIM || height > AVATAR_MAX_DIM)
    return `图片尺寸不能超过 ${AVATAR_MAX_DIM}×${AVATAR_MAX_DIM}（当前 ${width}×${height}）`;
  return null;
}

const zh = (m: string | undefined, fallback: string) => (m && /[\u4e00-\u9fff]/.test(m) ? m : fallback);

/** PUT /me/avatar 失败 → 中文提示（§1、§10.1 的错误码） */
export function avatarUploadErrorText(e: unknown): string {
  const err = e as { status?: number; code?: string; message?: string; details?: Record<string, unknown> } | null;
  if (err && typeof err.status === "number") {
    if (err.status === 413) return "图片不能超过 5 MB";
    if (err.status === 415) return "只支持 jpg、png、gif、webp 格式的图片（文件可能已损坏）";
    if (err.status === 400 && err.details?.field === "avatar")
      return /4096/.test(err.message ?? "") ? `图片尺寸不能超过 ${AVATAR_MAX_DIM}×${AVATAR_MAX_DIM}` : `图片无效：${zh(err.message, "请换一张")}`;
    if (err.status === 0) return "网络异常，请稍后再试";
    return zh(err.message, "上传失败");
  }
  return errorText(e, "上传失败");
}
