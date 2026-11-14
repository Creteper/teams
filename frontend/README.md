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

- 默认 `VITE_USE_MOCK=true`：内存 mock（`src/api/mock/`），刷新即重置。可用 `alice` / `bob` / `carol` / `dave` 登录，mock 不校验密码。
- `VITE_USE_MOCK=false`：真实后端（`src/api/http/`），REST 走 `Authorization: Bearer <SESSION_TOKEN>`，实时走 `/api/v1/ws`（首帧 `{type:"auth",token}`）。
- 参考 `.env.example`；本地覆盖写 `.env.local`（已忽略，不要提交任何令牌）。

## 目录

```
src/
  api/            接口层（类型按 docs/api.md，snake_case）
    types.ts      数据类型 + WS 帧类型
    client.ts     TeamsApi / RealtimeClient 接口
    config.ts     VITE_USE_MOCK 等开关
    http/         真实实现：fetch + Bearer、WebSocket（鉴权帧、4401、ping、指数退避重连）
    mock/         内存 mock（db.ts 种子数据、mockApi.ts、mockRealtime.ts 模拟 bot 回复/推送）
  lib/            纯逻辑：@ 补全与 <@member_id> 编解码、上传前置校验、消息分组、头像优先级
  components/     TeamRail、ChannelSidebar、MessageList、Composer、MemberList、MemberAvatar、TeamForms
  pages/          登录、注册、Team 列表、Team 主界面
  auth/           会话上下文
```

## 约定

- @ 提及：输入框显示 `@显示名`，发送时转为 `<@member_id>`；渲染时用 `mentions` / 成员表替换回名字。
- 头像优先级：`avatar_shape`/`avatar_color`（程序化 bot 头像，待接入 BotAvatar）→ `avatar_url` → 首字母头像。
- 上传：先 `POST /api/v1/teams/{id}/attachments` 拿 id 再发消息；图片 jpeg/png/gif/webp ≤10MB、视频 mp4/webm/mov ≤100MB（前端前置校验）。
