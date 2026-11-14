import { describe, expect, it } from "vitest";
import type { Message } from "../api/types";
import { applyAttachmentUrls, chunk, idsNeedingRefresh } from "./attachments";

const att = (id: string, url: string, expires_at = "2099-01-01T00:00:00Z") => ({
  id,
  kind: "image" as const,
  mime_type: "image/png",
  size_bytes: 1,
  file_name: `${id}.png`,
  width: null,
  height: null,
  duration_ms: null,
  url,
  expires_at,
});
const msg = (id: string, attachments: ReturnType<typeof att>[]): Message => ({
  id,
  seq: 1,
  team_id: "t",
  channel_id: "c",
  sender: { member_id: "m", type: "user", display_name: "M", avatar_url: null, avatar_shape: null, avatar_color: null },
  content: "",
  mentions: [],
  attachments,
  reply_to: null,
  trigger_depth: 0,
  created_at: "2026-11-14T00:00:00.000Z",
  edited_at: null,
  deleted: false,
});

describe("签名 URL 刷新", () => {
  const now = 1_763_130_000_000;
  const iso = (ms: number) => new Date(ms).toISOString();

  it("按 expires_at 只挑出 5 分钟内到期的附件，跳过 data:/blob:，去重", () => {
    const messages = [
      msg("1", [att("soon", "/a", iso(now + 60_000)), att("later", "/b", iso(now + 30 * 60_000))]),
      msg("2", [att("data", "data:image/png;base64,xx", iso(now)), att("soon", "/a", iso(now + 60_000))]),
    ];
    expect(idsNeedingRefresh(messages, now)).toEqual(["soon"]);
  });

  it("applyAttachmentUrls 替换 url，无变化返回原数组", () => {
    const messages = [msg("1", [att("a", "/old")])];
    const next = applyAttachmentUrls(messages, [{ id: "a", url: "/new", expires_at: "2099-01-02T00:00:00Z" }]);
    expect(next[0].attachments[0]).toMatchObject({ url: "/new", expires_at: "2099-01-02T00:00:00Z" });
    expect(applyAttachmentUrls(next, [{ id: "a", url: "/new", expires_at: "2099-01-02T00:00:00Z" }])).toBe(next);
  });

  it("chunk 按 100 分批", () => {
    expect(chunk(Array.from({ length: 205 }, (_, i) => i), 100).map((c) => c.length)).toEqual([100, 100, 5]);
  });
});
