# TeAms 前端

Vite + React 19 + TypeScript + HeroUI v3（Tailwind CSS v4）+ react-router，pnpm 管理。Discord 式四栏布局，深色主题。

## 开发

```bash
pnpm install
pnpm dev        # http://localhost:5190（strictPort；/api 与 WS 代理到 http://127.0.0.1:8090）
pnpm test       # vitest
pnpm build      # tsc -b 类型检查 + vite build
```

## Mock / 真实接口切换

`VITE_USE_MOCK` 决定用哪套实现（`src/api/index.ts`，构建期常量折叠）：

| 场景 | 未设置时 | 显式设置 |
|---|---|---|
| `pnpm dev` | 内存 mock（`src/api/mock/`，刷新即重置） | `false` = 真实后端 |
| `pnpm build`（生产） | **真实后端**，mock 代码/数据/提示文案都不进包 | `true` 才会把 mock 打进包（不要用于生产） |

- mock：可用 `alice` / `bob` / `carol` / `dave` 登录，mock 不校验密码；登录页的 Mock 提示只在 dev + mock 时出现。
- 真实后端（`src/api/http/`）：REST 走 `Authorization: Bearer <SESSION_TOKEN>`，实时走 `/api/v1/ws`（首帧 `{type:"auth",token}`）。
- 参考 `.env.example`；本地覆盖写 `.env.local`（已忽略，不要提交任何令牌）。例：`VITE_USE_MOCK=false pnpm dev` 连本地 8090。

## 生产构建

```bash
cd frontend
pnpm install --frozen-lockfile && pnpm build   # 不需要任何环境变量
```

- 产物：`frontend/dist/`（`index.html` + 带内容 hash 的 `assets/*` + 图标）。
- API：同源相对路径 `/api/v1/...`，由反向代理转发到后端 `127.0.0.1:8090`。
- WebSocket：按页面地址推导，`https://` 页面自动用 `wss://<host>/api/v1/ws`（反代需支持 Upgrade）；页面 Origin 要在后端 `TEAMS_CORS_ORIGINS` 白名单里，否则握手 403。
- SPA 路由：所有非文件路径（如 `/teams/...`、`/invite/<code>`）回退到 `index.html`。
- 缓存：`/assets/*`（文件名带 hash）可 `Cache-Control: public, max-age=31536000, immutable`；`index.html` 用 `no-cache`（每次协商），图标/manifest 用短缓存。
- 自检：`grep -ri mock dist/assets` 应无结果。

Caddy 示例：

```
teams.example.com {
  encode zstd gzip
  handle /api/* { reverse_proxy 127.0.0.1:8090 }
  handle {
    root * /srv/teams/frontend/dist
    @assets path /assets/*
    header @assets Cache-Control "public, max-age=31536000, immutable"
    @html path / /index.html
    header @html Cache-Control "no-cache"
    try_files {path} /index.html
    file_server
  }
}
```

## 联调（真实后端）

```bash
# 后端：cd backend && go run ./cmd/teams-server（监听 127.0.0.1:8090）
VITE_USE_MOCK=false pnpm dev
node e2e/integration.mjs   # 需在装有 playwright 的环境运行；账号随机生成，密码不打印
```

## 目录

```
src/
  api/            接口层（类型按 docs/api.md，snake_case）
    types.ts      数据类型 + WS 帧类型
    client.ts     TeamsApi / RealtimeClient 接口
    config.ts     VITE_USE_MOCK 等开关
    index.ts      按 VITE_USE_MOCK 选择实现（mock 走条件动态 import，生产默认不打包）
    http/         真实实现：fetch + Bearer、WebSocket（鉴权帧、4401、ping、指数退避重连）
    mock/         内存 mock（db.ts 种子数据、mockApi.ts、mockRealtime.ts 模拟 bot 回复/bot.run.*/推送、assets/ 示例视频）
  lib/            纯逻辑：@ 补全与 <@member_id> 编解码、上传前置校验、消息分组、头像优先级
  components/     TeamRail、ChannelSidebar、MessageList、Composer、MemberList、MemberAvatar、TeamForms
  pages/          登录、注册、Team 列表、Team 主界面
  auth/           会话上下文
```

## 约定

- @ 提及：输入框显示 `@显示名`，发送时转为 `<@member_id>`；渲染时用 `mentions` / 成员表替换回名字。
- 头像优先级：`avatar_shape`/`avatar_color`（程序化 BotAvatar）→ `avatar_url` → 首字母头像。
- 上传：先 `POST /api/v1/teams/{id}/attachments` 拿 id 再发消息；图片 jpeg/png/gif/webp ≤10MB、视频 mp4/webm/mov ≤100MB（前端前置校验）；上传用 XHR 显示进度、可取消。
