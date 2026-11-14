import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Card, Chip, Spinner, buttonVariants } from "@heroui/react";
import { api } from "../../api";
import type { SkillInfo } from "../../api/types";
import { formatBytes, installDir, skillErrorText } from "../../lib/skill";
import { FormError } from "../FormField";

type State = { kind: "loading" } | { kind: "error"; text: string } | { kind: "ready"; info: SkillInfo };

/**
 * 设置 → Skill 下载（docs/api.md §8.7）：GET /api/v1/skill?include=skill_md（不需要登录）。
 * 显示版本、文件大小、安装命令（install_command 原样显示 + 复制）、下载 SKILL.md（skill_md_url）/ tgz（tgz_url）、SKILL.md 预览。
 */
export function SkillDownload() {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [copied, setCopied] = useState<"ok" | "fail" | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const load = useCallback(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    api
      .getSkill({ includeSkillMd: true })
      .then((info) => !cancelled && setState({ kind: "ready", info }))
      .catch((e) => !cancelled && setState({ kind: "error", text: skillErrorText(e) }));
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => load(), [load]);
  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy(text: string) {
    clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(text);
      setCopied("ok");
    } catch {
      setCopied("fail");
    }
    timer.current = setTimeout(() => setCopied(null), 2000);
  }

  if (state.kind === "loading") {
    return (
      <div className="flex items-center gap-2 py-10 text-sm text-[#b5bac1]" data-testid="skill-loading" role="status">
        <Spinner size="sm" className="text-[#b5bac1]" />
        正在获取 Skill 信息…
      </div>
    );
  }
  if (state.kind === "error") {
    return (
      <Card className="gap-3 rounded-lg bg-[#2b2d31] p-4 shadow-none" data-testid="skill-error">
        <FormError>{state.text}</FormError>
        <div>
          <Button size="sm" variant="secondary" onPress={() => load()}>
            重试
          </Button>
        </div>
      </Card>
    );
  }
  const { info } = state;
  const linkBtn = (variant: "primary" | "secondary") => `${buttonVariants({ variant, size: "sm" })} no-underline`;
  return (
    <div className="flex flex-col gap-4" data-testid="skill-ready">
      <Card className="gap-3 rounded-lg bg-[#2b2d31] p-4 shadow-none">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-base font-semibold text-white">{info.skill_name}</span>
          <Chip size="sm" className="bg-brand/20 text-brand-light" data-testid="skill-version">
            <Chip.Label>v{info.version}</Chip.Label>
          </Chip>
          <span className="text-xs text-[#949ba4]" data-testid="skill-size">
            {info.name} · {formatBytes(info.size_bytes)}
          </span>
        </div>
        <p className="text-sm leading-relaxed text-[#b5bac1]">
          给要接入 TeAms 的 AI agent 用的说明书：接入步骤、webhook 载荷、bot 令牌接口、什么时候该 / 不该回复、防循环和排障。把它装进 agent 的工作目录，agent 就知道怎么当 TeAms 的 bot。
        </p>
      </Card>

      <Card className="gap-2 rounded-lg bg-[#2b2d31] p-4 shadow-none">
        <div className="text-xs font-semibold tracking-wide text-[#b5bac1]">安装命令</div>
        {/* 命令自动换行（窄屏也能看全），不靠横向滚动 */}
        <div className="flex items-start gap-2 rounded-md bg-[#1e1f22] py-1.5 pr-1.5 pl-3">
          <code className="min-w-0 flex-1 py-1 font-mono text-[13px] leading-5 break-all whitespace-pre-wrap text-[#f2f3f5]" data-testid="skill-install-command">
            {info.install_command}
          </code>
          <Button size="sm" variant={copied === "ok" ? "secondary" : "primary"} onPress={() => void copy(info.install_command)} aria-label="复制安装命令">
            {copied === "ok" ? "已复制 ✓" : "复制"}
          </Button>
        </div>
        {copied === "fail" ? <FormError>复制失败，请手动选中命令复制。</FormError> : null}
        <p className="text-xs leading-relaxed text-[#949ba4]" data-testid="skill-install-hint">
          默认装到 <code className="font-mono text-[#dbdee1]">{installDir(info.install_path)}</code>，可以加 <code className="font-mono text-[#dbdee1]">--dir</code> 指定目录，加{" "}
          <code className="font-mono text-[#dbdee1]">--force</code> 覆盖。
        </p>
      </Card>

      <Card className="gap-3 rounded-lg bg-[#2b2d31] p-4 shadow-none">
        <div className="flex flex-wrap items-center gap-2">
          <a className={linkBtn("primary")} href={info.skill_md_url} download="SKILL.md" target="_blank" rel="noreferrer" data-testid="skill-download-md">
            下载 SKILL.md
          </a>
          <a className={linkBtn("secondary")} href={info.tgz_url} download data-testid="skill-download-tgz">
            下载 tgz
          </a>
          <span className="text-xs text-[#949ba4]">tgz {formatBytes(info.size_bytes)}</span>
        </div>
        <div className="font-mono text-[11px] break-all text-[#b5bac1]" title="tgz 的 SHA-256" data-testid="skill-sha256">
          sha256 {info.sha256}
        </div>
      </Card>

      <Card className="gap-2 rounded-lg bg-[#2b2d31] p-4 shadow-none">
        <div className="text-xs font-semibold tracking-wide text-[#b5bac1]">SKILL.md 预览</div>
        {info.skill_md ? (
          // 只留外层窗口一层滚动：预览框不限高度，避免两层滚动滑错
          <div className="rounded-md bg-[#1e1f22]" data-testid="skill-preview">
            <pre className="p-3 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap text-[#dbdee1]">{info.skill_md}</pre>
          </div>
        ) : (
          <p className="text-sm text-[#949ba4]">没有返回预览内容，可以点「下载 SKILL.md」查看。</p>
        )}
      </Card>
    </div>
  );
}
