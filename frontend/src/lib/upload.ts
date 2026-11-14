import type { AttachmentKind } from "../api/types";

/** 上传前置校验，规则同 docs/api.md §5（最终以服务端嗅探为准） */
export const UPLOAD_RULES: Record<AttachmentKind, { mimes: string[]; maxBytes: number }> = {
  image: { mimes: ["image/jpeg", "image/png", "image/gif", "image/webp"], maxBytes: 10 * 1024 * 1024 },
  video: { mimes: ["video/mp4", "video/webm", "video/quicktime"], maxBytes: 100 * 1024 * 1024 },
};

export const ACCEPT_ATTR = [...UPLOAD_RULES.image.mimes, ...UPLOAD_RULES.video.mimes].join(",");

export type UploadCheck = { ok: true; kind: AttachmentKind } | { ok: false; reason: string };

export function checkUpload(file: { name: string; type: string; size: number }): UploadCheck {
  for (const kind of ["image", "video"] as const) {
    const rule = UPLOAD_RULES[kind];
    if (rule.mimes.includes(file.type)) {
      if (file.size > rule.maxBytes) {
        return { ok: false, reason: `${file.name} 超过${kind === "image" ? "图片" : "视频"}上限 ${rule.maxBytes / 1024 / 1024}MB` };
      }
      return { ok: true, kind };
    }
  }
  return { ok: false, reason: `${file.name} 类型不支持（图片 jpeg/png/gif/webp，视频 mp4/webm/mov）` };
}
