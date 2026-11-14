import { useState } from "react";
import { Button, Card, Input, Label } from "@heroui/react";
import { api } from "../api";
import type { Team } from "../api/types";

/**
 * 创建 team。第一版后端没有邀请码（docs/api.md §2.1），加入 team 由 owner/admin 在成员列表里按用户名添加。
 */
export function CreateTeamForm({ token, onDone }: { token: string; onDone(team: Team): void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      onDone(await api.createTeam(token, { name, description }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="bg-[#2b2d31]">
      <Card.Header>
        <Card.Title>创建 Team</Card.Title>
        <Card.Description>创建后你是 owner，会自动建 #general。想加入别人的 Team，请让对方的管理员按你的用户名添加你。</Card.Description>
      </Card.Header>
      <Card.Content className="flex flex-col gap-2">
        <Label htmlFor="team-name">Team 名称</Label>
        <Input id="team-name" placeholder="比如：TeAms 开发组" value={name} onChange={(e) => setName(e.target.value)} />
        <Label htmlFor="team-desc">简介（可选）</Label>
        <Input id="team-desc" value={description} onChange={(e) => setDescription(e.target.value)} />
        {error ? <p className="text-sm text-[#f23f43]">{error}</p> : null}
      </Card.Content>
      <Card.Footer>
        <Button variant="primary" isPending={busy} isDisabled={!name.trim()} onPress={() => void run()}>
          创建
        </Button>
      </Card.Footer>
    </Card>
  );
}

/** 浮层：从 team 图标栏的 “+” 打开 */
export function TeamDialog({ token, onClose, onDone }: { token: string; onClose(): void; onDone(team: Team): void }) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="创建 Team"
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/70 p-6"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-lg rounded-xl bg-[#313338] p-6 shadow-2xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-xl font-bold text-white">创建 Team</h2>
          <button type="button" aria-label="关闭" onClick={onClose} className="text-2xl text-[#b5bac1] hover:text-white">
            ×
          </button>
        </div>
        <CreateTeamForm token={token} onDone={onDone} />
      </div>
    </div>
  );
}
