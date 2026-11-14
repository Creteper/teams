# teams-skill

安装 TeAms bot 接入 skill（`teams-bot-integration`）的自托管 npm 包。**不发布到 npm**（`"private": true`），由 TeAms 后端托管 tgz：

```bash
npx -y https://teams.lovekaifa.com/api/v1/downloads/teams-skill.tgz             # → ./.cursor/skills/teams-bot-integration/SKILL.md
npx -y https://teams.lovekaifa.com/api/v1/downloads/teams-skill.tgz --force     # 覆盖已有文件
npx -y https://teams.lovekaifa.com/api/v1/downloads/teams-skill.tgz --dir docs  # → ./docs/SKILL.md
```

参数：`--dir <目录>`（写到 `<目录>/SKILL.md`）、`--force`、`--help`、`--version`。目标已存在且没加 `--force` 时以退出码 1 结束；参数错误退出码 2。无依赖，Node 18+。

开发：SKILL.md 唯一源文件是 `backend/skill/teams-bot-integration/SKILL.md`，打包时复制进来（见 `scripts/sync-skill.js`）。更新流程见 `docs/deploy.md`「Bot 接入 skill 包」。

```bash
npm test        # 本地冒烟（临时目录里跑 bin）
npm run dist    # 生成 ../../skill/dist/teams-skill-<version>.tgz（go:embed 进后端）
```
