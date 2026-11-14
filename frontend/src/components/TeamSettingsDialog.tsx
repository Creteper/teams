import { useState } from "react";
import { Button, Input, TextArea } from "@heroui/react";
import { api } from "../api";
import type { Team } from "../api/types";
import { TEAM_DESC_MAX, TEAM_NAME_MAX, charCount, validateTeamFields } from "../lib/text";
import { DialogShell } from "./ui";

/** Team 设置：改名称和简介（PATCH /teams/{id}，仅所有者/管理员） */
export function TeamSettingsDialog({ token, team, onClose, onSaved }: { token: string; team: Team; onClose(): void; onSaved(t: Team): void }) {
  const [name, setName] = useState(team.name);
  const [description, setDescription] = useState(team.description ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const invalid = validateTeamFields(name, description);

  async function save() {
    if (invalid) return setError(invalid);
    setPending(true);
    setError(null);
    try {
      const input: { name?: string; description?: string } = {};
      if (name.trim() !== team.name) input.name = name.trim();
      if (description.trim() !== (team.description ?? "")) input.description = description.trim();
      const t = Object.keys(input).length ? await api.updateTeam(token, team.id, input) : team;
      onSaved(t);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(false);
    }
  }

  return (
    <DialogShell label="Team 设置" title="Team 设置" onClose={onClose}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <label className="flex flex-col gap-1.5">
          <span className="flex justify-between text-xs font-semibold uppercase tracking-wide text-[#b5bac1]">
            名称 <Counter n={charCount(name.trim())} max={TEAM_NAME_MAX} />
          </span>
          <Input aria-label="Team 名称" value={name} placeholder="例如：TeAms 开发组" onChange={(e) => setName(e.target.value)} autoFocus />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="flex justify-between text-xs font-semibold uppercase tracking-wide text-[#b5bac1]">
            简介 <Counter n={charCount(description.trim())} max={TEAM_DESC_MAX} />
          </span>
          <TextArea
            aria-label="Team 简介"
            value={description}
            rows={4}
            placeholder="介绍一下这个 team 是做什么的（可选）"
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        {error ? (
          <p className="text-sm text-[#f23f43]" role="alert">
            {error}
          </p>
        ) : null}
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

export function Counter({ n, max }: { n: number; max: number }) {
  return <span className={`font-normal normal-case ${n > max ? "text-[#f23f43]" : "text-[#949ba4]"}`}>{n}/{max}</span>;
}
