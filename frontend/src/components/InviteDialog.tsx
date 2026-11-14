import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Input } from "@heroui/react";
import { api } from "../api";
import type { Invite, Member, Team } from "../api/types";
import {
  EXPIRY_OPTIONS,
  INVITE_STATUS_TEXT,
  MAX_USES_OPTIONS,
  inviteStatus,
  inviteUrl,
  type InviteStatus,
} from "../lib/invite";

const STATUS_CLASS: Record<InviteStatus, string> = {
  active: "bg-[#23a55a]/20 text-[#57f287]",
  expired: "bg-[#f0b232]/20 text-[#f0b232]",
  revoked: "bg-[#f23f43]/20 text-[#f23f43]",
  exhausted: "bg-[#949ba4]/20 text-[#b5bac1]",
};

function fmt(iso: string | null): string {
  if (!iso) return "永久";
  return new Date(iso).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

const selectClass =
  "w-full rounded-md bg-[#1e1f22] px-3 py-2 text-sm text-[#dbdee1] outline-none ring-1 ring-black/40 focus:ring-brand";

/** 邀请成员弹窗（owner/admin）：生成邀请链接、管理已有邀请、按用户名添加成员 */
export function InviteDialog({
  token,
  team,
  onClose,
  onMemberAdded,
}: {
  token: string;
  team: Team;
  onClose(): void;
  onMemberAdded(member: Member): void;
}) {
  const [expiryIdx, setExpiryIdx] = useState(2); // 默认 7 天
  const [usesIdx, setUsesIdx] = useState(0); // 默认不限
  const [created, setCreated] = useState<Invite | null>(null);
  const [copyHint, setCopyHint] = useState<string | null>(null);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [username, setUsername] = useState("");
  const [addMsg, setAddMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const linkRef = useRef<HTMLInputElement>(null);
  const origin = location.origin;

  const reload = useCallback(async () => {
    try {
      setInvites((await api.listInvites(token, team.id)).items);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [token, team.id]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function create() {
    setBusy(true);
    setError(null);
    setCopyHint(null);
    try {
      const seconds = EXPIRY_OPTIONS[expiryIdx].seconds;
      const maxUses = MAX_USES_OPTIONS[usesIdx].value;
      const inv = await api.createInvite(token, team.id, {
        ...(seconds ? { expires_in_seconds: seconds } : {}),
        ...(maxUses ? { max_uses: maxUses } : {}),
      });
      setCreated(inv);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopyHint("已复制到剪贴板");
    } catch {
      // 剪贴板不可用（非安全上下文 / 权限被拒）：选中文本让用户自己复制
      linkRef.current?.focus();
      linkRef.current?.select();
      setCopyHint("无法自动复制，已选中链接，请按 ⌘C / Ctrl+C 复制");
    }
  }

  async function revoke(inv: Invite) {
    try {
      await api.revokeInvite(token, team.id, inv.id);
      await reload();
      if (created?.id === inv.id) setCreated(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function addByUsername() {
    setAddMsg(null);
    try {
      const m = await api.addMember(token, team.id, { username, role: "member" });
      onMemberAdded(m);
      setAddMsg({ ok: true, text: `已添加 ${m.display_name}` });
      setUsername("");
    } catch (e) {
      setAddMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    }
  }

  const link = created ? inviteUrl(created, origin) : "";

  // Esc 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="邀请成员"
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/70 p-6"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="max-h-full w-full max-w-xl overflow-y-auto rounded-xl bg-[#313338] p-6 text-[#dbdee1] shadow-2xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-xl font-bold text-white">邀请成员加入 {team.name}</h2>
          <button type="button" aria-label="关闭" onClick={onClose} className="text-2xl text-[#b5bac1] hover:text-white">
            ×
          </button>
        </div>

        <section className="mb-6">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[#949ba4]">生成邀请链接</h3>
          <div className="grid grid-cols-2 gap-3">
            <label className="text-sm">
              <span className="mb-1 block text-[#b5bac1]">有效期</span>
              <select className={selectClass} value={expiryIdx} onChange={(e) => setExpiryIdx(Number(e.target.value))}>
                {EXPIRY_OPTIONS.map((o, i) => (
                  <option key={o.label} value={i}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-[#b5bac1]">使用次数</span>
              <select className={selectClass} value={usesIdx} onChange={(e) => setUsesIdx(Number(e.target.value))}>
                {MAX_USES_OPTIONS.map((o, i) => (
                  <option key={o.label} value={i}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="mt-3">
            <Button variant="primary" isPending={busy} onPress={() => void create()}>
              生成链接
            </Button>
          </div>
          {created ? (
            <div className="mt-3 rounded-md bg-[#1e1f22] p-3">
              <div className="flex gap-2">
                <input
                  ref={linkRef}
                  readOnly
                  value={link}
                  aria-label="邀请链接"
                  onFocus={(e) => e.currentTarget.select()}
                  className="min-w-0 flex-1 bg-transparent font-mono text-sm text-[#f2f3f5] outline-none"
                />
                <Button size="sm" variant="secondary" onPress={() => void copy(link)}>
                  复制
                </Button>
              </div>
              <p className="mt-1 text-xs text-[#949ba4]">
                {copyHint ??
                  `${created.expires_at ? `${fmt(created.expires_at)} 过期` : "永久有效"} · ${
                    created.max_uses ? `限 ${created.max_uses} 次` : "不限次数"
                  }`}
              </p>
            </div>
          ) : null}
          {error ? <p className="mt-2 text-sm text-[#f23f43]">{error}</p> : null}
        </section>

        <section className="mb-6">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[#949ba4]">已有邀请 — {invites.length}</h3>
          <ul className="divide-y divide-black/30 rounded-md bg-[#2b2d31]">
            {invites.length === 0 ? <li className="p-3 text-sm text-[#949ba4]">还没有邀请链接</li> : null}
            {invites.map((inv) => {
              const status = inviteStatus(inv);
              return (
                <li key={inv.id} className="flex items-center gap-3 p-3 text-sm">
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-mono text-[#f2f3f5]">{inv.url_path}</div>
                    <div className="text-xs text-[#949ba4]">
                      已用 {inv.uses}/{inv.max_uses ?? "∞"} · {inv.expires_at ? `${fmt(inv.expires_at)} 过期` : "永久"}
                    </div>
                  </div>
                  <span className={`rounded px-1.5 py-0.5 text-xs ${STATUS_CLASS[status]}`}>{INVITE_STATUS_TEXT[status]}</span>
                  {status === "active" ? (
                    <Button size="sm" variant="danger-soft" onPress={() => void revoke(inv)}>
                      作废
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>

        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[#949ba4]">按用户名添加</h3>
          <div className="flex gap-2">
            <Input
              aria-label="用户名"
              placeholder="对方的用户名"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && username.trim()) void addByUsername();
              }}
              className="flex-1"
            />
            <Button variant="secondary" isDisabled={!username.trim()} onPress={() => void addByUsername()}>
              添加
            </Button>
          </div>
          {addMsg ? (
            <p className={`mt-1 text-xs ${addMsg.ok ? "text-[#57f287]" : "text-[#f23f43]"}`}>{addMsg.text}</p>
          ) : null}
        </section>
      </div>
    </div>
  );
}
