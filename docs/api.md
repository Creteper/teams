# TeAms API 规范 v1

> 状态：**已与 backend 实现对齐**（第二阶段）。所有口令/令牌在文档中一律用占位符，如 `<SESSION_TOKEN>`、`<BOT_TOKEN>`。
> 变更记录见文末 [§14](#14-变更记录)。

## 0. 总则

| 项 | 约定 |
|---|---|
| 本地地址 | `http://127.0.0.1:8090`（后端只监听回环） |
| REST 前缀 | `/api/v1` |
| WebSocket | `ws://127.0.0.1:8090/api/v1/ws`（生产 `wss://teams.ruanyoutech.com/api/v1/ws`） |
| 编码 | 请求/响应 `application/json; charset=utf-8`；上传用 `multipart/form-data` |
| ID | UUID v7 字符串（时间有序） |
| 时间 | RFC 3339 UTC，毫秒精度，如 `2026-11-14T14:38:00.123Z` |
| 字段命名 | `snake_case`；可空字段一律返回 `null`（不省略） |
| 前端 | 开发端口 **5190**；CORS / WS Origin 白名单 `TEAMS_CORS_ORIGINS`，默认 `http://localhost:5190,http://127.0.0.1:5190`。前端路由 `/invite/<code>` 是邀请落地页 |
| 在线状态 | **不提供**任何 presence / online / typing 字段或事件 |

### 0.1 鉴权

都用 `Authorization: Bearer <...>`：

| 身份 | 令牌 | 获取 | 范围 |
|---|---|---|---|
| 用户会话 | `tas_…` → `<SESSION_TOKEN>` | 注册 / 登录返回 | 该用户所在全部 team |
| Bot | `tab_…` → `<BOT_TOKEN>` | 创建 bot / 轮换令牌时返回**一次** | 仅所属 team，且只能调 §8.4 列出的接口 |

- 服务端只存令牌 SHA-256；会话默认 30 天（`TEAMS_SESSION_TTL`），使用时滑动续期。
- 缺失/无效令牌 → `401 unauthorized`；令牌类型不对（如 bot 调用户接口）→ `403 forbidden`。
- 对**不可见**的资源（非成员访问 team/频道/消息/附件）统一返回 `404`，不泄露存在性。

### 0.2 错误格式

```json
{
  "error": { "code": "validation_failed", "message": "content 和 attachment_ids 不能同时为空", "details": { "field": "content" } },
  "request_id": "req_0193…"
}
```

| HTTP | code | 含义 |
|---|---|---|
| 400 | `bad_request` / `validation_failed` | 参数错误（`details.field` 指出字段） |
| 401 | `unauthorized` | 未登录、令牌无效、签名 URL 无效/过期 |
| 403 | `forbidden` | 角色不够 / 令牌类型不对 |
| 404 | `not_found` / `invite_not_found` | 不存在或不可见 |
| 409 | `conflict` / `owner_cannot_leave` | 重名、已是成员；owner 退出 |
| 410 | `invite_expired` / `invite_revoked` / `invite_exhausted` | 邀请失效 |
| 413 | `payload_too_large` | 上传超限（`details.max_bytes`） |
| 415 | `unsupported_media_type` | 文件类型不允许（`details.detected`）或 Content-Type 不对 |
| 422 | `avatar_fetch_failed` | 远程头像拉取失败（`details.reason`，见 §10.2） |
| 429 | `rate_limited` | 频率超限，带 `Retry-After`（秒） |
| 500 / 503 | `internal` / — | 服务端错误 / healthz 数据库不可用 |

每个响应带 `X-Request-Id`。

### 0.3 列表格式

所有列表接口返回统一信封：

```json
{ "items": [ … ], "next_cursor": "…或 null", "has_more": false }
```

| 接口 | 分页 |
|---|---|
| `GET /teams`、`GET /teams/{id}/channels`、`GET /teams/{id}/bots`、`GET /bots/{id}/webhook/deliveries` | 一次返回全部（deliveries 最近 100 条）；`next_cursor: null`、`has_more: false` |
| `GET /teams/{id}/members` | `limit` 默认 100、最大 200；`cursor` = 上一页 `next_cursor` |
| `GET /teams/{id}/invites` | `limit` 默认 50、最大 100；`cursor` |
| `GET /channels/{id}/messages` | 见 §5.4 |

例外：`GET /channels/{id}/bot-runs` 只返回 `{items}`；`POST /attachments/urls` 返回 `{items, missing}`。

---

## 1. 认证与当前用户

### POST /api/v1/auth/register
```json
// 请求
{ "username": "creteper", "password": "<PASSWORD>", "display_name": "Creteper" }
// 201
{ "user": { "id": "…", "username": "creteper", "display_name": "Creteper", "avatar_url": null, "created_at": "…" },
  "token": "<SESSION_TOKEN>", "expires_at": "…" }
```
- `username`：3–32 位 `[A-Za-z0-9_.-]`，不区分大小写唯一（重复 → 409）。
- `password`：8–128 字符，argon2id 存储。`display_name` 可省（默认用户名），1–64 字符。
- 注册和登录按 IP 限流（`TEAMS_AUTH_RATE_PER_MINUTE`，默认 20/分钟）。

### POST /api/v1/auth/login
`{ "username": "...", "password": "<PASSWORD>" }` → 200，结构同注册。失败统一 `401`（不区分用户不存在/密码错）。

### POST /api/v1/auth/logout
吊销当前会话 → `204`。

### GET /api/v1/me
**直接返回 User 对象**（不包 `{user}`）：
```json
{ "id": "…", "username": "creteper", "display_name": "Creteper", "avatar_url": "/api/v1/avatars/<avatar_id>", "created_at": "…" }
```
- `PATCH /api/v1/me` `{ "display_name": "…" }` → User；推送 `member.updated` 到该用户所在每个 team。
- `PUT /api/v1/me/avatar`（multipart 字段 `file`）/ `DELETE /api/v1/me/avatar` → User，见 §10。

---

## 2. Team

角色：`owner`（创建者，唯一）> `admin` > `member`；bot 成员角色固定 `bot`。

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| POST | `/api/v1/teams` | 用户 | `{name, description?}`；创建者为 owner，自动建 `general` 频道 |
| GET | `/api/v1/teams` | 用户 | 我加入的全部 team（列表信封） |
| GET | `/api/v1/teams/{team_id}` | 成员（含 bot） | 详情 |
| PATCH | `/api/v1/teams/{team_id}` | owner/admin | `{name?, description?}` → Team，推送 `team.updated` |
| DELETE | `/api/v1/teams/{team_id}` | owner | 软删除 → 204，推送 `team.deleted` |
| PUT / DELETE | `/api/v1/teams/{team_id}/icon` | owner/admin | 上传（multipart `file`）/清除图标 → Team，推送 `team.updated` |

- `name`：去掉首尾空白后 **1–50** 个 Unicode 字符，不能含控制字符。
- `description`：去掉首尾空白后 **0–500** 个 Unicode 字符（允许换行）。

Team 对象：
```json
{ "id": "…", "name": "TeAms 开发组", "description": "", "icon_url": "/api/v1/avatars/<avatar_id>",
  "owner_user_id": "…", "my_member_id": "…", "my_role": "owner", "created_at": "…" }
```
`icon_url` 可空；`my_member_id` / `my_role` 是调用者在该 team 的身份。

---

## 3. 成员

成员（member）是 team 内统一身份；用户和 bot 都是成员，`@`、发消息都用 **member_id**。`type` 区分 `user` / `bot`（前端据此显示 BOT 标记）。

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/api/v1/teams/{team_id}/members` | 成员（含 bot） | `?type=user|bot&limit=&cursor=`；按 member id（≈加入时间）升序 |
| POST | `/api/v1/teams/{team_id}/members` | owner/admin | 按用户名添加：`{ "username": "tina", "role": "member" }`（role 可为 `member`/`admin`）→ 201 Member；已是成员 → 409 |
| PATCH | `/api/v1/teams/{team_id}/members/{member_id}` | owner/admin | `{ "role": "admin"|"member" }`；不能改 owner 和 bot |
| DELETE | `/api/v1/teams/{team_id}/members/{member_id}` | owner/admin，或本人 | 移除 → 204；owner 不能被移除（403），owner 移除自己 → 409 `owner_cannot_leave`；bot 请用 `DELETE /bots/{id}` |
| DELETE | `/api/v1/teams/{team_id}/members/me` | 本人（用户） | 退出 team → 204；owner → **409 `owner_cannot_leave`** |

Member 对象：
```json
{ "id": "<member_id>", "team_id": "…", "type": "user", "user_id": "…", "bot_id": null,
  "display_name": "Tina", "username": "tina", "avatar_url": null,
  "avatar_shape": null, "avatar_color": null, "role": "member", "joined_at": "…" }
```
bot 成员：`"type": "bot"`, `"bot_id": "…"`, `"user_id": null`, `"role": "bot"`，`username` 为 bot 的 `name`，`avatar_shape` / `avatar_color` 见 §8.2。

**推送规则**（按用户名添加与接受邀请一致）：
- 加入：被加入的用户本人连接收到 `team.joined`（完整 Team 对象），并自动订阅该 team；team 里其他人收到 `member.joined`（本人不收）。
- 移出/退出：本人连接收到 `team.removed` 并取消订阅；其他人收到 `member.left`。

---

## 4. 邀请链接

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| POST | `/api/v1/teams/{team_id}/invites` | owner/admin | 创建 |
| GET | `/api/v1/teams/{team_id}/invites` | owner/admin | 列表（含已失效），`limit`/`cursor`，新的在前 |
| DELETE | `/api/v1/teams/{team_id}/invites/{invite_id}` | owner/admin | 作废（设 `revoked_at`）→ 204，重复调用仍 204 |
| GET | `/api/v1/invites/{code}` | **无需登录** | 落地页预览，按 IP 限流（`TEAMS_INVITE_PREVIEW_RATE_PER_MINUTE`，默认 30/分钟） |
| POST | `/api/v1/invites/{code}/accept` | 用户会话（bot 令牌 403） | 加入 |

创建：
```json
// POST /api/v1/teams/{team_id}/invites   （body 可为 {} 或省略）
{ "expires_in_seconds": 86400, "max_uses": 10 }
// 201 Invite
{ "id": "…", "code": "aZ3k9QmP0x", "team_id": "…", "url_path": "/invite/aZ3k9QmP0x",
  "expires_at": "…或 null", "max_uses": 10, "uses": 0, "revoked_at": null,
  "created_by": "<member_id>", "created_at": "…" }
```
- `expires_in_seconds`：60–2592000（30 天）；省略 = 永不过期。`max_uses`：1–1000；省略 = 不限次数。
- `code`：10 位 base62（`[0-9A-Za-z]`），crypto/rand 生成，全局唯一。

预览：
```json
// GET /api/v1/invites/aZ3k9QmP0x
{ "code": "aZ3k9QmP0x",
  "team": { "id": "…", "name": "TeAms 开发组", "icon_url": null, "member_count": 5 },
  "expires_at": null, "valid": false, "reason": "expired" }
```
`reason` 仅在 `valid: false` 时出现：`revoked` / `expired` / `exhausted`（优先级同此顺序）。code 不存在或 team 已删除 → `404 invite_not_found`。`member_count` 含 bot。

接受：
```json
// POST /api/v1/invites/{code}/accept → 200
{ "team": { …Team… }, "member": { …Member… }, "already_member": false }
```
- 已是成员：200、`already_member: true`、**不计次数**（即使邀请已失效）。
- 失效：410 `invite_expired` / `invite_revoked` / `invite_exhausted`。
- 次数校验与 `uses + 1` 在同一事务里对邀请行加锁完成，并发下不会超过 `max_uses`。
- 推送同 §3（本人 `team.joined`，其他人 `member.joined`）。

---

## 5. 频道与消息

### 5.1 频道

team 成员（用户和 bot）可在任意频道读写，无需加入频道。

| 方法 | 路径 | 权限 |
|---|---|---|
| GET | `/api/v1/teams/{team_id}/channels` | 成员（含 bot），列表信封，默认频道在前 |
| POST | `/api/v1/teams/{team_id}/channels` | 用户成员（bot 不可）`{ "name": "backend", "topic": "" }` → 201，推送 `channel.created` |
| GET | `/api/v1/channels/{channel_id}` | 成员 |
| PATCH | `/api/v1/channels/{channel_id}` | owner/admin/创建者，`{name?, topic?}`，推送 `channel.updated` |
| DELETE | `/api/v1/channels/{channel_id}` | owner/admin；默认频道不能删（403）→ 204，推送 `channel.deleted` |

`name` 1–64 字符，team 内不区分大小写唯一（409）；`topic` ≤ 250。

Channel 对象：
```json
{ "id": "…", "team_id": "…", "name": "general", "topic": "", "is_default": true,
  "created_by_member_id": "…", "last_message_seq": 1024, "created_at": "…" }
```

### 5.2 消息对象

```json
{
  "id": "0193a1b2-…",
  "seq": 1025,
  "team_id": "…",
  "channel_id": "…",
  "sender": { "member_id": "…", "type": "user", "display_name": "Creteper",
              "avatar_url": null, "avatar_shape": null, "avatar_color": null },
  "content": "<@0193aaaa-…> 帮我总结一下今天的讨论",
  "mentions": [ { "member_id": "0193aaaa-…", "type": "bot", "display_name": "Grok" } ],
  "attachments": [ { …Attachment，见 §6… } ],
  "reply_to": null,
  "trigger_depth": 0,
  "created_at": "…",
  "edited_at": null,
  "deleted": false
}
```
- `sender` 字段与成员对象一致：`member_id`、`type`、`display_name`、`avatar_url`、`avatar_shape`、`avatar_color`。
- `seq`：全局单调递增整数，用于分页与断线补拉。**同一频道内 seq 顺序与消息可见顺序一致**：已经看到 seq=N 的客户端，之后用 `after=N` 不会漏掉任何 seq<N 的消息。
- `reply_to`：被回复消息 id（必须同频道）。
- `trigger_depth`：防循环深度（§7.4），服务端计算。
- 已删除消息：`deleted: true`、`content: ""`、`mentions` 与 `attachments` 为空。

### 5.3 @ 格式

- 正文用 **`<@member_id>`**，如 `<@0193aaaa-1111-7000-8000-000000000001> 你好`（UUID 大小写不敏感）。
- 服务端解析全部 `<@uuid>`：只有本 team 的**在职**成员（bot 未删除）进入 `mentions`，去重、按首次出现排序，最多 20 个；无效标记原样保留为文本。
- 前端渲染时把 `<@id>` 换成 `@display_name`。不支持 `@所有人`。

### 5.4 发送

`POST /api/v1/channels/{channel_id}/messages`（用户会话或 bot 令牌）
```json
{ "content": "<@0193bbbb-…> 已完成", "attachment_ids": ["…"], "reply_to": "0193a1b2-…", "client_msg_id": "c-0193…" }
```
- `content` ≤ 8000 字符；`content`（去空白后）与 `attachment_ids` 至少一个非空。
- `attachment_ids` ≤ 10，必须是本 team、**本人上传**、尚未被引用的附件（否则 400）。
- `client_msg_id`（可选）：1–64 字符，字符集 `[A-Za-z0-9_-]`（`c-<uuid>` 合法）。**同一发送者、同一频道、24 小时内**重复提交返回原消息（**200**，不重复创建、不重复触发 webhook）；首次创建返回 **201**。
- 频率：用户 20 条/10 秒；bot 30 条/分钟/频道 → 429。
- 推送 `message.created`。

### 5.5 拉取（分页）

`GET /api/v1/channels/{channel_id}/messages?limit=50[&before=<seq>|&after=<seq>]`（limit 默认 50，最大 100；before 与 after 不能同时用）

| 请求 | 返回 | `next_cursor` |
|---|---|---|
| 不带参数 | 最新的 N 条 | 本页**最小** seq，供下一次 `before=` |
| `before=<seq>` | seq 小于它的最近 N 条 | 本页**最小** seq |
| `after=<seq>` | seq 大于它的最早 N 条 | 本页**最大** seq，供下一次 `after=` |

- `items` **一律按 seq 升序**（旧的在前，前端直接渲染）。
- `next_cursor` 为 seq 的十进制字符串；本页为空时为 `null`。`has_more: false` 表示该方向没有更多。

`GET /api/v1/messages/{message_id}` 单条。

### 5.6 编辑 / 删除

- `PATCH /api/v1/messages/{message_id}` `{ "content": "…" }`：仅发送者；重新解析 mentions；推送 `message.updated`；**编辑不触发 webhook**。
- `DELETE /api/v1/messages/{message_id}`：发送者或 owner/admin；软删除 → 204；推送 `message.deleted` `{id, channel_id, seq}`。

---

## 6. 附件（图片 / 视频）

### 6.1 上传
`POST /api/v1/teams/{team_id}/attachments`（用户会话或 bot 令牌；multipart，字段 **`file`**；流式写盘）

| kind | 允许类型（**按文件头嗅探**，不信任扩展名/Content-Type） | 上限 |
|---|---|---|
| `image` | jpeg / png / gif / webp | 10 MB（`TEAMS_MAX_IMAGE_BYTES`） |
| `video` | mp4 / webm / quicktime(mov) | 100 MB（`TEAMS_MAX_VIDEO_BYTES`） |

其它类型 → 415（`details.detected`）；超限 → 413（`details.max_bytes`）。上传后 24 小时内未被消息引用会被清理。

→ 201 Attachment：
```json
{ "id": "…", "kind": "image", "mime_type": "image/png", "size_bytes": 23456, "file_name": "截图.png",
  "width": 1280, "height": 720, "duration_ms": null,
  "url": "/api/v1/attachments/<id>/content?exp=<UNIX>&sig=<SIG>", "expires_at": "…" }
```
- `url` 是**相对路径**的签名地址，可直接用于 `<img>` / `<video>`，有效期 **1 小时**（`expires_at`）。
- `width`/`height` 仅图片；`duration_ms` 目前恒为 `null`（未解析视频时长）。

### 6.2 刷新签名
- `GET /api/v1/attachments/{id}` → 该 Attachment（新的 `url` 与 `expires_at`）。不可见 → 404。
- `POST /api/v1/attachments/urls` `{ "ids": ["…", …] }`（1–100 个，去重）→
  `{ "items": [ …Attachment… ], "missing": ["不可见或不存在的 id"] }`，`items` 保持请求顺序。

### 6.3 内容
`GET /api/v1/attachments/{id}/content?exp=&sig=`：签名有效即可访问（不需要 Authorization）；不带签名时也可用 Bearer 令牌访问。签名无效/过期 → 401。支持 Range；`Content-Disposition: inline`、`X-Content-Type-Options: nosniff`。所属消息删除后不可访问。

---

## 7. Bot 与 Webhook

### 7.1 触发条件

消息里 `@` 了某 bot 成员（解析结果 `mentions` 中有它），且不是 bot 自己 @ 自己 → 为该 bot 建一条投递记录：

| 情况 | 投递记录 | 推送 |
|---|---|---|
| bot 有已启用的 webhook，通过防循环检查 | `pending` → 发送 | `bot.run.started` … |
| bot **没有**（或已停用）webhook | `failed`、`last_error: "no_webhook"` | `bot.run.failed`（`reason: "no_webhook"`） |
| 超过深度上限 | `skipped_depth` | 无 |
| 超过频率上限 | `skipped_rate_limited` | 无 |

编辑消息不触发。普通消息不推给 bot（bot 可用 WS 自行订阅）。

### 7.2 请求

```
POST <webhook url>
Content-Type: application/json
User-Agent: TeAms-Webhook/1.0
X-TeAms-Event: message.mention        （测试为 ping）
X-TeAms-Delivery: <delivery_id>       （重试时不变，用于去重）
X-TeAms-Timestamp: <unix 秒>
X-TeAms-Signature: sha256=<hex>
<secret_header_name>: <SECRET_HEADER_VALUE>   （若配置）
```

签名：`hex(HMAC-SHA256(signing_secret, timestamp + "." + raw_body))`。接收方应校验签名并拒绝时间戳偏差 > 5 分钟的请求。

Payload（**发送时**根据最新数据生成；消息在发送前被删除则该投递放弃）：
```json
{
  "event": "message.mention",
  "delivery_id": "…",
  "sent_at": "…",
  "bot":     { "id": "…", "member_id": "…", "name": "grok", "display_name": "Grok",
               "avatar_url": "https://…/api/v1/avatars/…", "avatar_shape": "squircle", "avatar_color": "#5865F2" },
  "team":    { "id": "…", "name": "TeAms 开发组", "icon_url": null },
  "channel": { "id": "…", "name": "general" },
  "sender":  { "member_id": "…", "type": "user", "user_id": "…", "bot_id": null, "username": "creteper",
               "display_name": "Creteper", "avatar_url": null, "avatar_shape": null, "avatar_color": null },
  "message": { "id": "…", "seq": 1025, "content": "<@…> 帮我总结", "content_plain": "@Grok 帮我总结",
               "mentions": [ … ], "attachments": [ { "id": "…", "kind": "image", "mime_type": "image/png", "size_bytes": 1,
               "file_name": "a.png", "width": 1, "height": 1, "url": "https://…/content?exp=…&sig=…" } ],
               "reply_to": null, "trigger_depth": 0, "created_at": "…" },
  "loop_guard": { "trigger_depth": 0, "max_trigger_depth": 3, "reply_depth_will_be": 1 },
  "reply": { "method": "POST", "url": "https://…/api/v1/channels/<channel_id>/messages",
             "auth": "Authorization: Bearer <BOT_TOKEN>",
             "body_hint": { "content": "<@<sender_member_id>> …", "reply_to": "<message_id>" } }
}
```
URL 均为基于 `TEAMS_PUBLIC_BASE_URL` 的绝对地址。ping 只含 `event/delivery_id/sent_at/bot/team`。

### 7.3 超时与重试

- 超时 10 秒（`TEAMS_WEBHOOK_TIMEOUT`），不跟随到内网的重定向（每一跳都重新校验地址），不走系统代理。
- 2xx = 成功；**5xx / 429 / 超时 / 网络错误** 重试；其它 4xx 与地址被拦截不重试。
- 共 4 次：首次 + 10 秒、60 秒、300 秒后（±20% 抖动；429 的 `Retry-After` 更长时用它）。
- 队列在 PostgreSQL（`webhook_deliveries`），`FOR UPDATE SKIP LOCKED` 租约，进程重启不丢。
- 投递记录状态：`pending` / `succeeded` / `failed` / `skipped_depth` / `skipped_rate_limited`；保留 7 天。

### 7.4 防循环

- `trigger_depth`：人发的消息 = 0；bot 带 `reply_to` 发的 = 父消息 depth + 1；bot 不带 `reply_to` 发的 = 1。
- 只有 `depth ≤ TEAMS_MAX_TRIGGER_DEPTH`（默认 3）的消息才触发 webhook。
- 同一 bot 在同一频道 60 秒内最多触发 `TEAMS_WEBHOOK_RATE_PER_MINUTE`（默认 10）次（事务内 advisory lock 计数，`no_webhook` 记录不计入）。
- bot @ 自己不触发。

### 7.5 地址安全（SSRF）

webhook URL 必须 `https://`；webhook 与远程头像都在**建立连接时**检查解析出的 IP，拒绝 loopback、私网（10/8、172.16/12、192.168/16）、链路本地（169.254/16 含云元数据）、CGNAT 100.64/10、组播、保留段、IPv6 ULA/链路本地等。`198.18.0.0/15` **不拦截**（Clash fake-ip 场景，域名会被解析到此段）。

开发开关 **`TEAMS_WEBHOOK_ALLOW_INSECURE_LOCAL=true`**：允许 `http://` 与本机/内网地址（便于本地接收器）。**只在 `TEAMS_ENV=dev` 时生效**，其它环境会忽略并打印警告；默认 `false`，生产必须为 `false`。

### 7.6 Bot 运行状态

用于在频道里显示"Grok 正在处理…"。所有事件推送给**整个 team**，`data` 都含：
`team_id, channel_id, bot_member_id, trigger_message_id, delivery_id, at`。

| 事件 | 时机 | 额外字段 |
|---|---|---|
| `bot.run.started` | 投递入队（防循环/限流跳过的不发） | — |
| `bot.run.delivered` | webhook 返回 2xx | `attempt`, `status_code` |
| `bot.run.retrying` | 失败且将重试 | `attempt`, `next_retry_at`, `reason`, `status_code` |
| `bot.run.failed` | 最终失败 | `attempt?`, `reason`, `status_code`（可空） |
| `bot.run.completed` | 该 bot 发出 `reply_to = trigger_message_id` 的消息 | `reply_message_id` |

`reason`：`no_webhook` / `timeout` / `network_error` / `http_error` / `invalid_url`，另有 `message_deleted`（发送前触发消息被删）。
状态存在投递记录里；`completed` 优先级最高，之后到达的 delivered/retrying 不会覆盖它。

`GET /api/v1/channels/{channel_id}/bot-runs?active=true`（成员，含 bot）→
```json
{ "items": [ { "delivery_id": "…", "team_id": "…", "channel_id": "…", "bot_member_id": "…", "trigger_message_id": "…",
  "status": "retrying", "attempt": 1, "next_retry_at": "…", "reason": "http_error", "status_code": 503,
  "reply_message_id": null, "started_at": "…", "updated_at": "…" } ] }
```
`active=true`：状态为 started/delivered/retrying 且 10 分钟内创建的（最多 100 条，旧的在前）——页面刷新后恢复"处理中"状态用。不带 `active`：最近 50 条（新的在前）。

---

## 8. Bot 管理

### 8.1 管理接口（用户会话，owner/admin）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/v1/teams/{team_id}/bots` | 创建 → 201 `{bot, token, warnings?}`；`token` 只返回这一次；推送 `member.joined` |
| GET | `/api/v1/teams/{team_id}/bots` | 成员（含 bot）可读，列表信封；非 owner/admin 看到的 `webhook` 为 `null` |
| GET | `/api/v1/bots/{bot_id}` | 同上 |
| PATCH | `/api/v1/bots/{bot_id}` | `{display_name?, description?, avatar_url?, avatar_shape?, avatar_color?}` → Bot |
| DELETE | `/api/v1/bots/{bot_id}` | 软删除，令牌立即失效 → 204；推送 `member.left` |
| PUT / DELETE | `/api/v1/bots/{bot_id}/avatar` | 上传（multipart `file`）/清除 → Bot |
| POST | `/api/v1/bots/{bot_id}/token/rotate` | → `{ "bot_id": "…", "token": "<BOT_TOKEN>" }`，旧令牌立即失效 |
| PUT | `/api/v1/bots/{bot_id}/webhook` | 创建/更新 webhook（§8.3） |
| DELETE | `/api/v1/bots/{bot_id}/webhook` | 删除 → 204 |
| POST | `/api/v1/bots/{bot_id}/webhook/signing-secret/rotate` | → `{ "signing_secret": "<WHSEC>" }` |
| POST | `/api/v1/bots/{bot_id}/webhook/test` | 同步发一次 ping → `{ "ok": true, "delivery_id": "…", "status_code": 200, "result": "" }`（`result` 为错误分类，如 `http_500` / `timeout` / `blocked_address` / `network_error`） |
| GET | `/api/v1/bots/{bot_id}/webhook/deliveries` | 最近 100 条，列表信封 |

创建：
```json
{ "name": "grok", "display_name": "Grok", "description": "",
  "avatar_url": "https://example.com/grok.png", "avatar_shape": "squircle", "avatar_color": "#5865F2" }
```
- `name`：3–32 位 `[A-Za-z0-9_.-]`，team 内唯一（409）。`display_name` 1–64；`description` ≤ 500。
- 远程头像拉取失败**不影响创建**，返回 `warnings: [{code:"avatar_fetch_failed", message}]`。

Bot 对象：
```json
{ "id": "…", "member_id": "…", "team_id": "…", "name": "grok", "display_name": "Grok", "description": "",
  "avatar_url": "/api/v1/avatars/…", "avatar_source_url": "https://example.com/grok.png",
  "avatar_shape": "squircle", "avatar_color": "#5865F2",
  "webhook": { "url": "https://…", "enabled": true, "secret_header_name": "Authorization", "secret_header_set": true, "updated_at": "…" },
  "created_at": "…" }
```

Delivery 对象：`{id, message_id, channel_id, event, status, attempts, last_status_code, last_error, next_attempt_at, created_at, finished_at}`（`next_attempt_at` 仅 pending 时有值；ping 的 message_id/channel_id 为 null）。

### 8.2 头像样式字段 `avatar_shape` / `avatar_color`

- 出现在 Bot、Member（bot 成员）、消息 `sender`、`member.updated` 事件和 webhook payload 的 `bot` / `sender` 对象中。**可空**（`null`）；用户成员目前恒为 `null`。
- **原样存储**：只去掉首尾空白，不转小写、不做格式校验（`"Squircle"`、`"#5865f2"`、`"rgb(1,2,3)"` 都按原样返回）；前端自行解释。
- 限制：≤ 64 个字符，不能含控制字符（400）。空字符串或 `null` → 存为 `null`。

### 8.3 Webhook 配置

`PUT /api/v1/bots/{bot_id}/webhook`
```json
{ "url": "https://bot.example.com/teams", "enabled": true,
  "secret_header_name": "Authorization", "secret_header_value": "Bearer <SECRET_HEADER_VALUE>" }
```
- `url` 必须 https 且通过 §7.5 检查（被拦截 → 400，`details.reason: "blocked_address"`）。`enabled` 省略为 `true`。
- `secret_header_name`：合法 HTTP token、≤ 64；不能是 `Host`、`Content-Type`、`Content-Length`、`User-Agent`、`Transfer-Encoding`、`Connection`、`TE`、`Trailer`、`Upgrade`，也不能以 `X-TeAms-` 开头。`Authorization` 允许。
- `secret_header_value`：≤ 1024 字节，不能含 CR/LF/NUL；AES-GCM 加密存储，**任何接口都不回显**（只返回 `secret_header_set`）。
- 更新时省略 `secret_header_*` 保持不变；`secret_header_name: null` 清除；换新的 header 名必须同时给值。
- 首次创建时响应里包含一次 `signing_secret`（`whsec_…`），之后只能轮换。响应为 webhook 对象。

### 8.4 Bot 令牌可调用的接口

| 接口 | 说明 |
|---|---|
| `GET /api/v1/bots/me`（别名 `/api/v1/bot/me`） | `{bot, member, team}`（`webhook` 恒为 null） |
| `PATCH /api/v1/bots/me` | 修改自己的资料（§8.5） |
| `PUT / DELETE /api/v1/bots/me/avatar` | 上传（multipart `file`）/清除头像 → `{bot, member}` |
| `GET /api/v1/teams/{team_id}`、`/members`、`/channels`、`/bots` | 仅所属 team |
| `GET /api/v1/channels/{id}`、`/messages`、`/bot-runs`；`GET /api/v1/messages/{id}` | |
| `POST /api/v1/channels/{id}/messages`；`PATCH / DELETE /api/v1/messages/{id}`（仅自己的） | |
| `POST /api/v1/teams/{team_id}/attachments`、`GET /api/v1/attachments/{id}`、`POST /api/v1/attachments/urls` | |
| `GET /api/v1/ws` | |

其它接口 → 403。

### 8.5 PATCH /api/v1/bots/me

JSON：
```json
{ "display_name": "Grok", "description": "…", "avatar_url": "https://example.com/new.png",
  "avatar_shape": "circle", "avatar_color": "#ff0000" }
```
- 只允许这 5 个字段，出现其它字段（如 `name`、`webhook`）→ 400 `validation_failed`。
- `avatar_url: null` 或 `""` 清除头像。同一 URL 且内容 SHA-256 未变 → 不重复保存、不推送。
- 也可用 multipart：文本字段 `display_name` / `description` / `avatar_url` / `avatar_shape` / `avatar_color`，文件字段 **`avatar`**（不能与 `avatar_url` 同时给）。
- 返回 `{bot, member}`；有变化时推送 `member.updated`（data 为 Member）。
- 频率：每个 bot 6 次/分钟（`/bots/me` 的 PATCH 和头像上传共用）。

---

## 9. WebSocket

### 9.1 连接与鉴权

`GET /api/v1/ws`，两种方式任选：
1. 请求头 `Authorization: Bearer <TOKEN>`（bot / 服务端客户端）；
2. 浏览器连接后 **5 秒内**发第一帧 `{ "type": "auth", "token": "<SESSION_TOKEN>" }`。

失败：发 `{"type":"error","data":{"code":"unauthorized",…}}` 后以关闭码 **4401** 关闭。浏览器连接校验 `Origin`（同 `TEAMS_CORS_ORIGINS`）。

成功后服务端发：
```json
{ "type": "ready", "data": { "member_ids": { "<team_id>": "<member_id>" }, "server_time": "…", "last_seq": 1024 } }
```
连接自动订阅其所在全部 team（bot 只有自己的 team）。

### 9.2 帧格式

所有帧都有 `type`。team 范围的事件：
```json
{ "type": "message.created", "id": "evt_…", "ts": "…", "team_id": "…", "data": { … } }
```
`ready`、`pong`、`error` **没有** `team_id`。

客户端 → 服务端：`{"type":"ping"}` → `{"type":"pong","data":{}}`；其它类型 → `{"type":"error","data":{"code":"unknown_type",…}}`。60 秒内无任何帧则断开，客户端应每 ~25 秒 ping。发送队列积压（慢消费者）会被断开（1008）。

### 9.3 事件

| type | data | 接收者 |
|---|---|---|
| `message.created` / `message.updated` | Message | team |
| `message.deleted` | `{id, channel_id, seq}` | team |
| `channel.created` / `channel.updated` | Channel | team |
| `channel.deleted` | `{id}` | team |
| `member.joined` | Member | team（加入者本人除外） |
| `member.updated` | Member | team（改昵称/头像/bot 资料） |
| `member.left` | `{member_id}` | team（离开者本人除外） |
| `team.joined` | Team（含 my_member_id / my_role） | **仅**被加入的用户，之后自动订阅 |
| `team.updated` | Team | team |
| `team.removed` | `{team_id}` | **仅**被移出/退出的用户，之后取消订阅 |
| `team.deleted` | `{team_id}` | team |
| `bot.run.*` | 见 §7.6 | team |

没有 presence / typing 事件。断线重连后用 `GET /channels/{id}/messages?after=<最后 seq>` 补拉。

---

## 10. 头像与 Team 图标

### 10.1 上传
- 用户：`PUT /api/v1/me/avatar`；Team：`PUT /api/v1/teams/{id}/icon`；Bot：`PUT /api/v1/bots/{id}/avatar`、`PUT /api/v1/bots/me/avatar`；multipart 字段 `file`。
- 只接受 jpeg / png / gif / webp（嗅探），≤ 5 MB（`TEAMS_MAX_AVATAR_BYTES`），宽高 ≤ 4096。服务端**不裁剪不缩放**。
- `GET /api/v1/avatars/{avatar_id}`：**公开**、`Cache-Control: public, max-age=31536000, immutable`；每次更换都生成新 id，所以 URL 变化即刷新。

### 10.2 远程头像（bot 的 `avatar_url`）
服务端下载一次存本地（不热链）；SSRF 防护同 §7.5，但允许 `http://`。超时 10 秒，≤ 5 MB。失败 → `422 avatar_fetch_failed`，`details.reason`：
`invalid_url` / `blocked_address` / `timeout` / `network_error` / `http_<状态码>` / `too_large` / `unsupported_type`。

---

## 11. 频率限制汇总

| 对象 | 限制 | 配置 |
|---|---|---|
| 注册 / 登录 | 每 IP 20 次/分钟 | `TEAMS_AUTH_RATE_PER_MINUTE` |
| 邀请预览 | 每 IP 30 次/分钟 | `TEAMS_INVITE_PREVIEW_RATE_PER_MINUTE` |
| 用户发消息 | 每成员 20 条/10 秒 | — |
| bot 发消息 | 每 bot 每频道 30 条/分钟 | — |
| bot 改资料 | 每 bot 6 次/分钟 | — |
| webhook 触发 | 每 bot 每频道 10 次/60 秒（超出记 skipped_rate_limited） | `TEAMS_WEBHOOK_RATE_PER_MINUTE` |

IP 取连接地址；只有来自本机回环的请求（即 Caddy 反代）才信任 `X-Forwarded-For` / `CF-Connecting-IP`。限流在进程内存中，单实例有效。

## 12. 健康检查

`GET /api/v1/healthz` → `{"status":"ok"}`；数据库不可用 → 503 `{"status":"db_unavailable"}`。

## 13. 配置（环境变量）

见 `backend/.env.example`（全部为占位符）。关键项：`TEAMS_ENV`（`dev`/`production`，默认 production）、`TEAMS_HTTP_ADDR`（默认 `127.0.0.1:8090`）、`TEAMS_PUBLIC_BASE_URL`、`TEAMS_DATABASE_URL`、`TEAMS_SECRET_KEY`（≥32 字节随机，用于加密 webhook 密钥与签名附件 URL）、`TEAMS_UPLOAD_DIR`、`TEAMS_CORS_ORIGINS`、`TEAMS_WEBHOOK_ALLOW_INSECURE_LOCAL`。数据库迁移在启动时自动执行。

---

## 14. 变更记录

### 第二阶段（实现对齐）相对第一阶段草案的改动

1. **列表统一信封** `{items, next_cursor, has_more}`：teams / channels / bots / deliveries 一次返回全部；members 支持 `limit`（默认 100、最大 200）+ `cursor`，按 member id 升序；invites 新增分页。
2. **`GET /me` 直接返回 User 对象**；新增 `PATCH /me`。
3. **消息列表**：不带参数返回最新 N 条；`items` 一律按 seq 升序；`next_cursor` 为十进制字符串（before/无参数=本页最小 seq，after=最大 seq）。
4. **`client_msg_id`**：1–64 位 `[A-Za-z0-9_-]`；同发送者同频道 24 小时内幂等；重复提交返回 **200** + 原消息（首次 201）。
5. **`sender`** 字段固定为 `member_id, type, display_name, avatar_url, avatar_shape, avatar_color`。
6. **新增 `avatar_shape` / `avatar_color`**（bot）：可空、原样存储（仅 trim）、≤64、无控制字符；出现在 Bot、Member、sender、member.updated、webhook payload。
7. **附件**：对象新增 `expires_at`；签名有效期 1 小时；新增 `GET /attachments/{id}` 与 `POST /attachments/urls`（≤100，返回 `items` + `missing`）；视频类型新增 quicktime；`duration_ms` 暂为 null。
8. **WebSocket**：每帧都有 `type`；team 事件带 `team_id`，ready/pong/error 不带；新增 `team.joined`（仅本人，自动订阅）与 `team.removed`（仅本人，取消订阅）；`member.joined`/`member.left` 不再发给本人；**删除 typing 事件**（无 presence）；鉴权失败关闭码 4401。
9. **邀请链接**（新增 §4）：`team_invites` 表、创建/列表/作废/公开预览/接受；错误码 `invite_not_found`(404)、`invite_expired`/`invite_revoked`/`invite_exhausted`(410)；前端路由 `/invite/<code>`。按用户名添加成员保留。
10. **Bot 运行状态**（新增 §7.6）：`bot.run.started/delivered/retrying/failed/completed` 事件与 `GET /channels/{id}/bot-runs?active=true`；failed 的 reason 额外有 `message_deleted`；不带 `active` 返回最近 50 条。
11. **无 webhook 的 bot 被 @**：记录一条 `failed`（`last_error: no_webhook`）投递并推送 `bot.run.failed`（之前草案为不记录）；该记录不计入频率限制。
12. **Team**：对象新增 `description`；新增 `PATCH /teams/{id}`（owner/admin，name 1–50、description 0–500，推送 `team.updated`）；创建时 name 也是 1–50。
13. **退出 team**：新增 `DELETE /teams/{id}/members/me`；owner 退出（含 owner 删除自己的 member_id）→ **409 `owner_cannot_leave`**；移除 owner → 403。
14. **开发开关改名**：`TEAMS_WEBHOOK_ALLOW_PRIVATE` → **`TEAMS_WEBHOOK_ALLOW_INSECURE_LOCAL`**，且只在 `TEAMS_ENV=dev` 生效；新增 `TEAMS_ENV`。
15. **前端开发端口 5173 → 5190**，CORS / WS Origin 默认白名单随之改变。
16. **Bot 令牌权限**：可调用 `GET /teams/{id}`、`/teams/{id}/bots`、`/bot-runs`、附件刷新接口；`/bot/me` 作为 `/bots/me` 的别名保留；`GET /bots/me` 返回 `{bot, member, team}`。
17. **`PATCH /bots/me`**：JSON 出现未知字段 → 400；支持 multipart（文本字段同名，文件字段 `avatar`）；返回 `{bot, member}`；同 URL 同内容不重复保存。
18. **Webhook 配置**：允许 `Authorization` 作为 secret header；禁止保留头与 `X-TeAms-*`；首次创建返回一次 `signing_secret`；新增 `signing-secret/rotate`；`test` 返回 `{ok, delivery_id, status_code, result}`。
19. **Webhook payload 在发送时生成**（而非入队时），因此重试会带上最新的 bot 资料和新的附件签名；消息在发送前删除则放弃投递。payload 中 bot/sender 新增样式字段，message 新增 `content_plain`，新增 `loop_guard` 与 `reply` 提示。
20. **SSRF**：`198.18.0.0/15` 不再拦截（Clash fake-ip）；每一跳重定向都重新校验；出站请求不使用系统代理。
21. **远程头像失败**统一为 `422 avatar_fetch_failed` + `details.reason`（新增 `network_error`）；创建 bot 时以 `warnings` 返回而不失败。
22. **非 admin 读取 bot 时 `webhook` 为 null**。
23. 新增 IP 频率限制：注册/登录、邀请预览（§11）。
24. 频道创建/修改仅限用户会话（bot 不可）；频道名 1–64、topic ≤250。
