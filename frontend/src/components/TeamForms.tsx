import { useState } from "react";
import { useNavigate } from "react-router";
import { Button, Input, TextArea } from "@heroui/react";
import { api } from "../api";
import type { Team } from "../api/types";
import { TEAM_DESC_MAX, TEAM_NAME_MAX, charCount, parseInviteInput, validateTeamFields } from "../lib/text";
import { Field, FormError } from "./FormField";
import { Counter } from "./TeamSettingsDialog";
import { DialogShell } from "./ui";

/** 创建 team：名称 1–50、简介 0–500（Unicode 计数），带字数统计 */
export function CreateTeamForm({ token, onDone }: { token: string; onDone(team: Team): void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const invalid = validateTeamFields(name, description);

  async function run() {
    if (invalid) return setError(invalid);
    setBusy(true);
    setError(null);
    try {
      onDone(await api.createTeam(token, { name: name.trim(), description: description.trim() }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        void run();
      }}
    >
      <p className="text-sm text-[#b5bac1]">创建后你是所有者，会自动建好 #general 频道。</p>
      <Field id="team-name" label={<span className="flex justify-between">Team 名称 <Counter n={charCount(name.trim())} max={TEAM_NAME_MAX} /></span>}>
        <Input id="team-name" placeholder="例如：TeAms 开发组" value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field
        id="team-desc"
        label={<span className="flex justify-between">简介（可选） <Counter n={charCount(description.trim())} max={TEAM_DESC_MAX} /></span>}
      >
        <TextArea
          id="team-desc"
          rows={3}
          placeholder="一句话介绍这个 team，例如：TeAms 前后端协作与发布"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </Field>
      {error ? <FormError>{error}</FormError> : null}
      <div className="flex justify-end">
        <Button type="submit" variant="primary" isPending={busy} isDisabled={!!invalid}>
          创建 Team
        </Button>
      </div>
    </form>
  );
}

/** 通过邀请链接加入：粘贴链接或邀请码，跳到 /invite/:code 落地页 */
export function JoinByInviteForm({ onGo }: { onGo?(): void }) {
  const navigate = useNavigate();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        const code = parseInviteInput(value);
        if (!code) return setError("请粘贴有效的邀请链接（…/invite/邀请码）或邀请码");
        onGo?.();
        navigate(`/invite/${code}`);
      }}
    >
      <p className="text-sm text-[#b5bac1]">收到了邀请链接？粘贴到这里查看并加入。</p>
      <Field id="invite-input" label="邀请链接或邀请码">
        <Input id="invite-input" placeholder="粘贴邀请链接或邀请码" value={value} onChange={(e) => setValue(e.target.value)} />
      </Field>
      {error ? <FormError>{error}</FormError> : null}
      <div className="flex justify-end">
        <Button type="submit" variant="secondary" isDisabled={!value.trim()}>
          打开邀请
        </Button>
      </div>
    </form>
  );
}

/** 浮层：从 team 图标栏的 “+” 打开（创建 / 加入） */
export function TeamDialog({ token, onClose, onDone }: { token: string; onClose(): void; onDone(team: Team): void }) {
  const [tab, setTab] = useState<"create" | "join">("create");
  return (
    <DialogShell label="创建或加入 Team" title="创建或加入 Team" onClose={onClose}>
      <div className="mb-5 flex gap-1 rounded-lg bg-[#1e1f22] p-1" role="tablist">
        {(["create", "join"] as const).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={`flex-1 rounded-md py-1.5 text-sm font-medium ${tab === t ? "bg-brand text-white" : "text-[#b5bac1] hover:text-white"}`}
          >
            {t === "create" ? "创建 Team" : "通过邀请加入"}
          </button>
        ))}
      </div>
      {tab === "create" ? <CreateTeamForm token={token} onDone={onDone} /> : <JoinByInviteForm onGo={onClose} />}
    </DialogShell>
  );
}
