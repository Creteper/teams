# TeAms API 规范 v1

> 状态：第一阶段定稿草案（供前端 Tina 对齐）。所有口令/令牌在文档中一律用占位符，如 `<SESSION_TOKEN>`、`<BOT_TOKEN>`。

## 0. 总则

| 项 | 约定 |
|---|---|
| 本地地址 | `http://127.0.0.1:8090`（后端端口 **8090**；3000 被其他服务占用） |
| REST 前缀 | `/api/v1` |
| WebSocket | `ws://127.0.0.1:8090/api/v1/ws`（公网部署后为 `wss://<DOMAIN>/api/v1/ws`） |
| 编码 | 请求/响应均为 `application/json; charset=utf-8`（上传除外，用 `multipart/form-data`） |
| ID | UUID 字符串（v7，按时间有序），例如 `0193a1b2-...` |
| 时间 | RFC 3339 UTC，毫秒精度，例如 `2026-11-14T14:38:00.123Z` |
| 字段命名 | `snake_case` |
| 前端开发 | 建议 Vite dev server 把 `/api`（含 WS）代理到 `127.0.0.1:8090`；后端也支持 CORS（`TEAMS_CORS_ORIGINS`）。注意本机 `[::1]:5173` 当前已被一个 node 进程占用 |

### 0.1 鉴权

两种身份，都用 `Authorization: Bearer <...>` 头：

| 身份 | 令牌格式 | 获取方式 | 范围 |
|---|---|---|---|
| 用户会话 | `tas_<随机串>` → `<SESSION_TOKEN>` | 注册 / 登录返回 | 该用户所在的全部 team |
| Bot | `tab_<随机串>` → `<BOT_TOKEN>` | 创建 bot / 轮换令牌时返回**一次** | 仅该 bot 所属 team |

- 令牌在服务端只存 SHA-256 哈希，丢失只能轮换/重新登录。
- 会话默认有效期 30 天（`TEAMS_SESSION_TTL`），每次使用滑动续期。
- 缺失/无效令牌 → `401 unauthorized`；有令牌但无权限 → `403 forbidden`。

### 0.2 错误格式

所有非 2xx 响应：

```json
{
  "error": {
    "code": "validation_failed",
    "message": "content 和 attachment_ids 不能同时为空",
    "details": { "field": "content" }
  },
  "request_id": "req_01JCXYZ..."
}
```

| HTTP | code | 含义 |
|---|---|---|
| 400 | `bad_request` / `validation_failed` | 参数错误 |
| 401 | `unauthorized` | 未登录或令牌无效 |
| 403 | `forbidden` | 无权限（非成员、角色不够、bot 越权） |
| 404 | `not_found` | 资源不存在（或对你不可见） |
| 409 | `conflict` | 唯一性冲突（用户名已存在、频道重名等） |
| 413 | `payload_too_large` | 上传超限 |
| 415 | `unsupported_media_type` | 文件类型不允许 |
| 429 | `rate_limited` | 频率超限，带 `Retry-After` 头（秒） |
| 500 | `internal` | 服务端错误 |

### 0.3 分页

列表接口统一用游标：`?limit=50&before=<cursor>` 或 `?after=<cursor>`，响应：

```json
{ "items": [ ... ], "next_cursor": "..." , "has_more": true }
```

`limit` 默认 50，最大 100。

---

## 1. 认证

### POST /api/v1/auth/register
```json
// 请求
{ "username": "creteper", "password": "<PASSWORD>", "display_name": "Creteper" }
// 201 响应
{ "user": { "id": "…", "username": "creteper", "display_name": "Creteper", "avatar_url": null, "created_at": "…" },
  "token": "<SESSION_TOKEN>", "expires_at": "…" }
```
- `username`：3–32 位，`[a-z0-9_.-]`，不区分大小写唯一。
- `password`：8–128 位；服务端 argon2id 哈希。

### POST /api/v1/auth/login
请求 `{ "username": "...", "password": "<PASSWORD>" }`，响应同注册（200）。失败统一 `401 unauthorized`（不区分用户不存在/密码错）。登录接口按 IP 限流。

### POST /api/v1/auth/logout
吊销当前会话令牌。`204`。

### GET /api/v1/me
返回当前用户。`PATCH /api/v1/me` 可改 `display_name`、`avatar_attachment_id`。

---

## 2. Team

角色：`owner`（创建者，唯一）> `admin` > `member`。bot 的角色固定为 `bot`。

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| POST | `/api/v1/teams` | 登录用户 | 创建 team，创建者成为 owner；自动建 `general` 频道 |
| GET | `/api/v1/teams` | 登录用户 | 我加入的 team 列表 |
| GET | `/api/v1/teams/{team_id}` | 成员 | 详情 |
| PATCH | `/api/v1/teams/{team_id}` | owner/admin | 改 `name`、`description` |
| DELETE | `/api/v1/teams/{team_id}` | owner | 删除（级联频道、消息、bot） |

Team 对象：
```json
{ "id": "…", "name": "TeAms 开发组", "description": "", "owner_user_id": "…",
  "my_member_id": "…", "my_role": "owner", "created_at": "…" }
```

### 2.1 成员

成员（member）是 team 内的统一身份：用户和 bot 都是成员，`@`、发消息都用 **member_id**。

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/api/v1/teams/{team_id}/members` | 成员 | 列表（含 bot），支持 `?kind=user|bot` |
| POST | `/api/v1/teams/{team_id}/members` | owner/admin | 按用户名直接加人：`{ "username": "tina", "role": "member" }` |
| PATCH | `/api/v1/teams/{team_id}/members/{member_id}` | owner/admin | 改 `role`（不能改 owner） |
| DELETE | `/api/v1/teams/{team_id}/members/{member_id}` | owner/admin，或本人（退出） | 移除；owner 不能退出 |

Member 对象：
```json
{ "id": "<member_id>", "team_id": "…", "kind": "user", "user_id": "…", "bot_id": null,
  "display_name": "Tina", "username": "tina", "avatar_url": null, "role": "member", "joined_at": "…" }
```
bot 成员：`"kind": "bot"`, `"bot_id": "…"`, `"user_id": null`, `"role": "bot"`。

> 邀请链接（invite code）留到后续阶段；第一版按用户名直接添加。

---

## 3. 频道

team 成员（用户和 bot）可在 team 的**任意**频道读写，不需要单独加入频道。

| 方法 | 路径 | 权限 |
|---|---|---|
| GET | `/api/v1/teams/{team_id}/channels` | 成员 |
| POST | `/api/v1/teams/{team_id}/channels` | 用户成员（bot 不可建频道）`{ "name": "backend", "topic": "" }` |
| GET | `/api/v1/channels/{channel_id}` | 成员 |
| PATCH | `/api/v1/channels/{channel_id}` | owner/admin/创建者，改 `name`、`topic` |
| DELETE | `/api/v1/channels/{channel_id}` | owner/admin；`general` 不能删 |

- `name`：1–64 字符，team 内唯一（不区分大小写）。

Channel 对象：
```json
{ "id": "…", "team_id": "…", "name": "general", "topic": "", "created_by_member_id": "…",
  "last_message_seq": 1024, "created_at": "…" }
```

---

## 4. 消息

### 4.1 消息对象

```json
{
  "id": "0193a1b2-…",
  "seq": 1025,
  "team_id": "…",
  "channel_id": "…",
  "sender": { "member_id": "…", "kind": "user", "display_name": "Creteper", "avatar_url": null },
  "content": "<@0193aaaa-…> 帮我总结一下今天的讨论",
  "mentions": [
    { "member_id": "0193aaaa-…", "kind": "bot", "display_name": "Grok" }
  ],
  "attachments": [
    { "id": "…", "kind": "image", "mime_type": "image/png", "size_bytes": 20480,
      "file_name": "a.png", "width": 800, "height": 600, "duration_ms": null,
      "url": "/api/v1/attachments/…/content?exp=…&sig=…" }
  ],
  "reply_to": null,
  "trigger_depth": 0,
  "created_at": "…",
  "edited_at": null,
  "deleted": false
}
```

- `seq`：全局单调递增整数，用作分页游标和断线补拉。
- `reply_to`：被回复消息的 id（必须同频道），无则 `null`。
- `trigger_depth`：防循环深度，见 §7.4。服务端计算，客户端不能指定。

### 4.2 @ 格式

- 正文中用 **`<@member_id>`** 表示提及，例如 `<@0193aaaa-1111-7000-8000-000000000001> 你好`。
- 服务端发送时解析所有 `<@uuid>`：只有属于**本 team** 的成员才进入 `mentions`（去重、保持首次出现顺序）；无效 id 原样保留为文本。
- 前端渲染：把 `<@id>` 替换为 `@display_name`（用 `mentions` 或成员表查名字）；输入框选人后插入标记。
- 不支持 `@所有人`（第一版）。
- 单条消息最多 20 个有效 mention。

### 4.3 发送

`POST /api/v1/channels/{channel_id}/messages`（用户会话或 bot 令牌）

```json
{
  "content": "<@0193bbbb-…> 已完成，见附件",
  "attachment_ids": ["…"],
  "reply_to": "0193a1b2-…",
  "client_msg_id": "c-7f3a…"
}
```

- `content` 最长 8000 字符；`content` 与 `attachment_ids` 至少一个非空；`attachment_ids` 最多 10 个，必须是本 team、本人上传、尚未被其他消息引用的附件。
- `client_msg_id`（可选，≤64）：幂等键，同一发送者重复提交返回同一条消息。
- 响应 `201` + 消息对象；同时通过 WS 推送 `message.created`。
- 发送频率：用户 20 条/10 秒；bot 30 条/分钟/频道。超限 `429`。

### 4.4 拉取（分页）

`GET /api/v1/channels/{channel_id}/messages?limit=50&before=<seq>` —— 按 `seq` 倒序返回更早的消息（首屏不带 `before`）。
`GET /api/v1/channels/{channel_id}/messages?after=<seq>&limit=100` —— 按 `seq` 正序返回更新的消息（断线重连补拉）。

`GET /api/v1/messages/{message_id}` —— 单条。

### 4.5 编辑 / 删除

- `PATCH /api/v1/messages/{message_id}` `{ "content": "…" }`：仅发送者；重新解析 mentions；**编辑不触发 webhook**。
- `DELETE /api/v1/messages/{message_id}`：发送者或 owner/admin；软删除，之后返回 `deleted: true`、`content: ""`、无附件。

---

## 5. 文件上传

`POST /api/v1/teams/{team_id}/attachments`，`multipart/form-data`，字段 `file`（一次一个文件）。用户和 bot 都可上传。

| 类型 | 允许的 MIME（按文件头嗅探，不信任扩展名） | 大小上限 |
|---|---|---|
| 图片 `image` | `image/jpeg` `image/png` `image/gif` `image/webp` | 10 MB（`TEAMS_MAX_IMAGE_BYTES`） |
| 视频 `video` | `video/mp4` `video/webm` `video/quicktime` | 100 MB（`TEAMS_MAX_VIDEO_BYTES`） |

响应 `201`：
```json
{ "id": "<attachment_id>", "kind": "video", "mime_type": "video/mp4", "size_bytes": 5242880,
  "file_name": "demo.mp4", "width": null, "height": null, "duration_ms": null,
  "url": "/api/v1/attachments/<attachment_id>/content?exp=1763131200&sig=…" }
```

- 上传后拿 `id` 放进发消息的 `attachment_ids`。24 小时内未被消息引用的附件会被清理。
- 下载：`GET /api/v1/attachments/{id}/content`。可带 `Authorization` 头，或使用响应里的**签名 URL**（`exp` + `sig`，有效期 1 小时，便于 `<img>`/`<video>` 直接引用）。签名 URL 过期后重新拉消息即可得到新 URL。视频支持 `Range` 请求。
- 响应头带 `Content-Type`（嗅探结果）、`X-Content-Type-Options: nosniff`、`Content-Disposition: inline; filename="…"`。
- 超限 `413`，类型不符 `415`。

---

## 6. Bot 管理

bot 是 team 成员（`kind: bot`），由 owner/admin 创建和管理。

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| POST | `/api/v1/teams/{team_id}/bots` | owner/admin | 创建 bot 及其成员身份，返回令牌（只显示一次） |
| GET | `/api/v1/teams/{team_id}/bots` | 成员 | 列表（不含任何密钥） |
| GET | `/api/v1/bots/{bot_id}` | 成员 | 详情 |
| PATCH | `/api/v1/bots/{bot_id}` | owner/admin | 改 `display_name`、`description`、`avatar_attachment_id` |
| DELETE | `/api/v1/bots/{bot_id}` | owner/admin | 删除 bot（令牌立即失效，历史消息保留并显示为已删除 bot） |
| POST | `/api/v1/bots/{bot_id}/token/rotate` | owner/admin | 轮换令牌，旧令牌立即失效，返回新令牌一次 |
| PUT | `/api/v1/bots/{bot_id}/webhook` | owner/admin | 配置出站 webhook |
| DELETE | `/api/v1/bots/{bot_id}/webhook` | owner/admin | 移除 webhook |
| POST | `/api/v1/bots/{bot_id}/webhook/signing-secret/rotate` | owner/admin | 轮换 HMAC 签名密钥，返回一次 |
| POST | `/api/v1/bots/{bot_id}/webhook/test` | owner/admin | 发送一条 `ping` 事件，返回对方状态码 |
| GET | `/api/v1/bots/{bot_id}/webhook/deliveries` | owner/admin | 最近 100 条投递记录（状态、尝试次数、状态码、错误） |

### 6.1 创建
```json
// POST /api/v1/teams/{team_id}/bots
{ "name": "grok", "display_name": "Grok", "description": "Grok Bot 接入" }
// 201
{ "bot": { "id": "<bot_id>", "member_id": "<member_id>", "team_id": "…", "name": "grok",
           "display_name": "Grok", "description": "…", "webhook": null, "created_at": "…" },
  "token": "<BOT_TOKEN>" }
```
`name` 在 team 内唯一，规则同用户名。

### 6.2 配置 webhook
```json
// PUT /api/v1/bots/{bot_id}/webhook
{
  "url": "https://<GROK_WEBHOOK_URL>",
  "enabled": true,
  "secret_header_name": "X-Webhook-Secret",
  "secret_header_value": "<WEBHOOK_SECRET>"
}
// 200
{
  "url": "https://<GROK_WEBHOOK_URL>",
  "enabled": true,
  "secret_header_name": "X-Webhook-Secret",
  "secret_header_set": true,
  "signing_secret": "<SIGNING_SECRET>",   // 仅首次配置或轮换时返回
  "updated_at": "…"
}
```
- `secret_header_name`/`secret_header_value` 可选（要么都给要么都不给）；header 名须是合法 HTTP token（1–64 字符），禁止使用 `Host`、`Content-Type`、`Content-Length`、`User-Agent` 和 `X-TeAms-*` 前缀。值**只写不读**，GET 只返回 `secret_header_set`。
- 更新时省略 `secret_header_value` 表示保留原值。
- `url` 必须是 `https://`（本地开发可用 `TEAMS_WEBHOOK_ALLOW_PRIVATE=true` 放开 http 和内网地址）；默认拒绝解析到内网/回环地址（防 SSRF）。
- 密钥在库中用 `TEAMS_SECRET_KEY` 做 AES-GCM 加密存储。

### 6.3 Bot 用令牌调用 API

bot 令牌可用的接口（其余返回 `403`）：

| 方法 | 路径 |
|---|---|
| GET | `/api/v1/bot/me` → `{ bot, member, team }` |
| GET | `/api/v1/teams/{team_id}/channels`、`/api/v1/channels/{id}` |
| GET | `/api/v1/teams/{team_id}/members` |
| GET | `/api/v1/channels/{id}/messages`、`/api/v1/messages/{id}` |
| POST | `/api/v1/channels/{id}/messages` |
| PATCH/DELETE | `/api/v1/messages/{id}`（仅自己发的） |
| POST | `/api/v1/teams/{team_id}/attachments` |
| GET | `/api/v1/attachments/{id}/content` |

示例（Grok Bot 回复并 @ 对方）：
```bash
curl -X POST http://127.0.0.1:8090/api/v1/channels/<CHANNEL_ID>/messages \
  -H "Authorization: Bearer <BOT_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"content":"<@<SENDER_MEMBER_ID>> 总结如下……","reply_to":"<MESSAGE_ID>"}'
```
**回复时务必带 `reply_to` = webhook 里的 `message.id`**，否则防循环深度无法正确继承（见 §7.4）。

---

## 7. 出站 Webhook

### 7.1 触发条件

一条**新消息**（不含编辑）满足以下全部条件时，对其中每个被 @ 的 bot 各投递一次：

1. 该 bot 在 `mentions` 中，且配置了 webhook 且 `enabled: true`；
2. 发送者不是该 bot 自己（自己 @ 自己不触发）；
3. 消息 `trigger_depth <= TEAMS_MAX_TRIGGER_DEPTH`（默认 3）；
4. 该 bot 在该频道近 60 秒内的触发次数 `< TEAMS_WEBHOOK_RATE_PER_MINUTE`（默认 10）。

不满足 3/4 的情况会写一条投递记录，状态 `skipped_depth` / `skipped_rate_limited`，可在 deliveries 接口查看，不会重试。

### 7.2 请求

`POST <webhook url>`，请求头：

```
Content-Type: application/json
User-Agent: TeAms-Webhook/1.0
X-TeAms-Event: message.mention
X-TeAms-Delivery: <delivery_id>            # 同一投递的重试保持不变，用于去重
X-TeAms-Timestamp: 1763130000              # Unix 秒
X-TeAms-Signature: sha256=<hex>            # HMAC-SHA256(<SIGNING_SECRET>, "<timestamp>.<raw_body>")
<secret_header_name>: <WEBHOOK_SECRET>     # 若配置了发送方密钥头，例如 X-Webhook-Secret
```

接收方校验建议：比较密钥头（常量时间），和/或重算 HMAC 并检查 `|now - timestamp| <= 300` 秒。

### 7.3 载荷

```json
{
  "event": "message.mention",
  "delivery_id": "0193d001-…",
  "sent_at": "2026-11-14T14:38:01.000Z",
  "bot": { "id": "<bot_id>", "member_id": "<bot_member_id>", "name": "grok", "display_name": "Grok" },
  "team": { "id": "<team_id>", "name": "TeAms 开发组" },
  "channel": { "id": "<channel_id>", "name": "general" },
  "sender": { "member_id": "<sender_member_id>", "kind": "user", "user_id": "…", "bot_id": null,
              "username": "creteper", "display_name": "Creteper" },
  "message": {
    "id": "<message_id>",
    "seq": 1025,
    "content": "<@<bot_member_id>> 帮我总结一下今天的讨论",
    "content_plain": "@Grok 帮我总结一下今天的讨论",
    "mentions": [ { "member_id": "<bot_member_id>", "kind": "bot", "display_name": "Grok" } ],
    "attachments": [
      { "id": "…", "kind": "image", "mime_type": "image/png", "size_bytes": 20480, "file_name": "a.png",
        "url": "https://<PUBLIC_BASE_URL>/api/v1/attachments/…/content?exp=…&sig=…" }
    ],
    "reply_to": null,
    "trigger_depth": 0,
    "created_at": "2026-11-14T14:38:00.123Z"
  },
  "loop_guard": { "trigger_depth": 0, "max_trigger_depth": 3, "reply_depth_will_be": 1 },
  "reply": {
    "method": "POST",
    "url": "https://<PUBLIC_BASE_URL>/api/v1/channels/<channel_id>/messages",
    "auth": "Authorization: Bearer <BOT_TOKEN>",
    "body_hint": { "content": "<@<sender_member_id>> …", "reply_to": "<message_id>" }
  }
}
```

- `content_plain`：把 `<@id>` 替换成 `@显示名` 的纯文本，方便 LLM 直接阅读。
- 附件 `url` 是绝对地址的签名 URL（基于 `TEAMS_PUBLIC_BASE_URL`），有效期 1 小时。
- `reply` 只是提示，**载荷里不含任何令牌**；令牌由接收方自己保管。
- `ping` 事件（test 接口）：`{ "event": "ping", "delivery_id": "…", "sent_at": "…", "bot": {…}, "team": {…} }`。

### 7.4 防循环规则

1. **trigger_depth**：
   - 用户发的消息：`0`。
   - bot 发的消息带 `reply_to`：`父消息.trigger_depth + 1`。
   - bot 发的消息不带 `reply_to`：取 `1`（视为 bot 主动发言，仍会受频率限制）。
   - 只有 `trigger_depth <= MAX_TRIGGER_DEPTH`（默认 3）的消息才会触发 webhook。例：人 @A(0) → A 回复 @B(1) → B 回复 @A(2) → A 回复 @B(3) → B 回复 @A(4，**不再触发**)。
2. **频率限制**：每个 bot 每个频道 60 秒滑动窗口内最多触发 `TEAMS_WEBHOOK_RATE_PER_MINUTE` 次（默认 10），超出直接跳过（不排队）。
3. **自 @ 不触发**；同一消息对同一 bot 只投递一次。
4. bot 发消息本身也有频率上限（30 条/分钟/频道）。

### 7.5 超时与重试

- 单次请求超时 10 秒（`TEAMS_WEBHOOK_TIMEOUT`），不跟随重定向。
- `2xx` 视为成功（响应体忽略）。
- 网络错误、超时、`5xx`、`429` → 重试；其他 `4xx` → 失败不重试。
- 共最多 4 次尝试，间隔约 10 秒、60 秒、300 秒（带 ±20% 抖动；`429` 带 `Retry-After` 时取其与计划值的较大者）。
- 投递是异步的（存 PostgreSQL 队列），不阻塞发消息；服务重启后继续。语义为**至少一次**，接收方请按 `X-TeAms-Delivery` 去重。
- 投递状态：`pending` → `succeeded` / `failed`，或 `skipped_depth` / `skipped_rate_limited`。

---

## 8. 实时推送（WebSocket）

### 8.1 连接与鉴权

- 地址：`ws://127.0.0.1:8090/api/v1/ws`（生产 `wss://<DOMAIN>/api/v1/ws`）。
- 浏览器无法自定义头，所以连接后 **5 秒内**必须发送第一帧鉴权：
  ```json
  { "type": "auth", "token": "<SESSION_TOKEN>" }
  ```
  非浏览器客户端也可在握手时带 `Authorization: Bearer <...>` 头（bot 令牌同样可用，只收到所属 team 的事件）。
- 服务端校验 `Origin`（在 `TEAMS_CORS_ORIGINS` 内）。
- 鉴权成功后服务端回：
  ```json
  { "type": "ready", "data": { "member_ids": { "<team_id>": "<member_id>" }, "server_time": "…", "last_seq": 1025 } }
  ```
  失败则发 `{ "type": "error", "data": { "code": "unauthorized" } }` 并以 close code `4401` 关闭。
- 连接后自动订阅该用户所在**全部 team** 的事件，无需逐频道订阅。

### 8.2 帧格式

服务端 → 客户端：
```json
{ "type": "message.created", "id": "evt_…", "ts": "2026-11-14T14:38:00.130Z", "team_id": "…", "data": { … } }
```

| type | data |
|---|---|
| `ready` | 见上 |
| `message.created` | 完整消息对象（§4.1） |
| `message.updated` | 完整消息对象 |
| `message.deleted` | `{ "id": "…", "channel_id": "…", "seq": 1025 }` |
| `channel.created` / `channel.updated` | Channel 对象 |
| `channel.deleted` | `{ "id": "…" }` |
| `member.joined` / `member.updated` | Member 对象 |
| `member.left` | `{ "member_id": "…" }` |
| `team.updated` | Team 对象 |
| `team.deleted` / `team.removed` | `{ "team_id": "…" }`（removed：你被移出） |
| `typing` | `{ "channel_id": "…", "member_id": "…" }` |
| `pong` | `{}` |
| `error` | `{ "code": "…", "message": "…" }` |

客户端 → 服务端：

| type | 说明 |
|---|---|
| `auth` | 见上 |
| `ping` | 心跳，建议每 25 秒一次；服务端 60 秒无任何帧则断开 |
| `typing` | `{ "type": "typing", "channel_id": "…" }`，服务端节流 3 秒/频道 |

发消息**只走 REST**（WS 只做推送），保证有统一的校验、幂等和 webhook 触发。

### 8.3 断线重连

客户端记住收到的最大 `seq`，重连后对打开的频道调用 `GET /channels/{id}/messages?after=<seq>` 补拉；建议指数退避重连（1s, 2s, 4s … 最多 30s）。

示例：
```json
{ "type": "message.created", "id": "evt_01", "ts": "…", "team_id": "T1",
  "data": { "id": "M1", "seq": 1026, "channel_id": "C1",
            "sender": { "member_id": "B1", "kind": "bot", "display_name": "Grok" },
            "content": "<@U1> 总结如下……", "mentions": [ { "member_id": "U1", "kind": "user", "display_name": "Creteper" } ],
            "attachments": [], "reply_to": "M0", "trigger_depth": 1, "created_at": "…", "edited_at": null, "deleted": false } }
```

---

## 9. 其他

- `GET /api/v1/healthz` → `{ "status": "ok" }`（不需鉴权，含 DB 连通检查）。
- 每个响应带 `X-Request-Id`。
