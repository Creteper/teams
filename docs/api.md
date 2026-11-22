# TeAms API 规范 v1

> 状态：**已与 backend 实现对齐**（第二阶段）。所有口令/令牌在文档中一律用占位符，如 `<SESSION_TOKEN>`、`<BOT_TOKEN>`。
> 变更记录见文末 [§14](#14-变更记录)。

## 0. 总则

| 项 | 约定 |
|---|---|
| 本地地址 | `http://127.0.0.1:8090`（后端只监听回环） |
| REST 前缀 | `/api/v1` |
| WebSocket | `ws://127.0.0.1:8090/api/v1/ws`（生产 `wss://teams.lovekaifa.com/api/v1/ws`） |
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
| 429 | `rate_limited` | 频率超限，带 `Retry-After`（秒，向上取整，最小 1）；各项限额见 §11 |
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
吊销当前会话 → `204`。该会话登记的浏览器推送订阅（§9.4）一并删除。

### GET /api/v1/me
**直接返回 User 对象**（不包 `{user}`）：
```json
{ "id": "…", "username": "creteper", "display_name": "Creteper", "avatar_url": "/api/v1/avatars/<avatar_id>", "created_at": "…" }
```
- `PATCH /api/v1/me` `{ "display_name": "…" }` → User；推送 `member.updated` 到该用户所在每个 team。
- `PUT /api/v1/me/avatar`（multipart 字段 `file`）/ `DELETE /api/v1/me/avatar` → 200 User（仅用户会话），格式和限制见 §10.1。
  - 上传成功后推送 `member.updated`（新的 `avatar_url`）到该用户所在每个 team，与改昵称相同。
  - `DELETE` 是幂等的：本来就没有头像也返回 200 User（`avatar_url: null`），这种情况**不推送**；真的清除了才推 `member.updated`（`avatar_url: null`）。
  - 错误：不是 multipart → 415；multipart 里没有 `file` 字段（字段名必须是 `file`）→ 400 `validation_failed`（`details.field: "file"`）；文件为空 → 400（`field: "avatar"`）；超过大小上限 → 413 `payload_too_large`；格式不对或图片解不开 → 415 `unsupported_media_type`；宽或高超过 4096 → 400 `validation_failed`（`field: "avatar"`，直接拒绝，不缩放）。
  - 被替换 / 清除的旧头像文件约 1 小时后由后台清理删除；旧 URL 届时 404。

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
| GET | `/api/v1/teams/{team_id}/members/{member_id}` | 成员（含 bot） | 单个成员资料（"查看资料"用）→ 200 Member；已退出的成员 / 已删除的 bot 也能查到（`deleted: true`），便于从旧消息点开；不是本 team 的成员或 id 无效 → 404 |
| PATCH | `/api/v1/teams/{team_id}/members/{member_id}` | owner/admin（用户会话） | `{ "role": "admin"|"member" }` → 200 Member；不能改 owner 和 bot，规则见下 |
| DELETE | `/api/v1/teams/{team_id}/members/{member_id}` | owner/admin，或本人 | 移除 → 204；owner 不能被移除（403），owner 移除自己 → 409 `owner_cannot_leave`；bot 请用 `DELETE /bots/{id}` |
| DELETE | `/api/v1/teams/{team_id}/members/me` | 本人（用户） | 退出 team → 204；owner → **409 `owner_cannot_leave`** |

Member 对象：
```json
{ "id": "<member_id>", "team_id": "…", "type": "user", "user_id": "…", "bot_id": null,
  "display_name": "Tina", "username": "tina", "avatar_url": null,
  "avatar_shape": null, "avatar_color": null, "description": null, "role": "member", "joined_at": "…" }
```
bot 成员：`"type": "bot"`, `"bot_id": "…"`, `"user_id": null`, `"role": "bot"`，`username` 为 bot 的 `name`，`description` 为 bot 的描述（用户成员恒为 `null`），`avatar_shape` / `avatar_color` 见 §8.2。
所有返回 Member 的地方（列表、单个、`member.*` 事件）都带 `description`。已退出 / 已删除的成员只会在单个查询里出现，并带 `"deleted": true`。

**修改角色（`PATCH /teams/{team_id}/members/{member_id}`）**：

| 调用者 | 目标 | 结果 |
|---|---|---|
| owner | admin / member（用户） | 200，可升可降 |
| admin | 其他 admin / member（用户） | 200，**可以把其他 admin 降为 member**，也可以把 member 升为 admin |
| admin | 自己 | 200，可以把自己降为 member（降完就失去管理权限，不能自己再升回去） |
| owner | 自己 | 403 `forbidden`（owner 的角色不能改；转让 owner 目前没有接口） |
| owner / admin | owner 或 bot 成员 | 403 `forbidden`「不能修改 owner 或 bot 的角色」 |
| member | 任何人 | 403 `forbidden`「需要 owner 或 admin」 |
| bot 令牌 | — | 403（仅用户会话） |

- `role` 只能是 `"admin"` 或 `"member"`（区分大小写；`"owner"`、`"bot"`、空串都不行）→ 否则 400 `validation_failed`，`details.field: "role"`。目标是 owner/bot 时先返回 403，不再校验 role。
- 目标成员不存在、id 无效、不在本 team、已退出 → 404 `not_found`；调用者不是该 team 成员 → 404。
- 没有 409：设成和现在相同的角色也返回 200（当前 Member），但**不写库、不推送**。
- 角色真的变了才推送 `member.updated`（新的 Member）给整个 team，**包括被改的人自己**，前端据此刷新自己的权限（`team.my_role` 不会单独推 `team.updated`）。

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
| PATCH | `/api/v1/channels/{channel_id}` | owner/admin/创建者（用户会话），`{name?, topic?}` → 200 Channel，推送 `channel.updated` |
| DELETE | `/api/v1/channels/{channel_id}` | owner/admin（用户会话）；默认频道不能删（403）→ 204，推送 `channel.deleted` |
| POST | `/api/v1/channels/{channel_id}/read` | 用户会话（bot 403）；标记已读，见 §5.7 |
| PUT / DELETE | `/api/v1/channels/{channel_id}/pin` | 用户会话（bot 403）；置顶 / 取消置顶（只影响自己），见 §5.7 |
| GET | `/api/v1/me/unread` | 用户会话；所有 team 里有未读的频道汇总，见 §5.7 |

**名称规则**（创建和改名相同）：
- 先去掉首尾空白（`TrimSpace`），再按字符（Unicode 码点，不是字节）计 1–64；中文、空格、`#`、emoji、标点都允许，**只禁止控制字符**（换行、制表符等）→ 否则 400 `validation_failed`，`details.field: "name"`。
- team 内**不区分大小写**唯一，只和未删除的频道比较（删掉的频道名可以再用）；把自己改成仅大小写不同的名字可以。重名 → 409 `conflict`「频道名已存在」，`details.field: "name"`。
- `topic` 去首尾空白后 ≤ 250 字符，可为空，同样禁止控制字符（`field: "topic"`）。
- `PATCH` 只改传了的字段；即使什么都没改也返回 200 并推送 `channel.updated`。

**权限**：

| 操作 | owner | admin | 频道创建者（member） | 其他 member | bot 令牌 |
|---|---|---|---|---|---|
| 改名 / 改 topic（含默认频道） | ✓ | ✓ | ✓（仅自己建的） | 403 | 403 |
| 删除普通频道 | ✓ | ✓ | 403 | 403 | 403 |
| 删除默认频道 | 403「默认频道不能删除」 | 403 | 403 | 403 | 403 |

默认频道（`is_default: true`）**可以改名**，改名后仍是默认频道，只是不能删。

**删除是软删除**：频道记 `deleted_at`，消息和附件记录留在库里但**不再可访问**——频道、它的消息列表、单条消息、编辑/删除/decline 都 → 404；这些消息的附件 `GET /attachments/{id}`、`/content`（含之前签发的签名 URL）→ 404，`POST /attachments/urls` 把它们放进 `missing`；附件文件本身不立即删除。还没发出的 webhook 投递会被放弃；未读汇总里不再出现该频道。只推送一条 `channel.deleted`（`data: {id}`）给整个 team，不逐条推 `message.deleted`；前端收到后从列表移除，若正在看该频道应跳走（例如回默认频道）。目前没有恢复接口。

Channel 对象：
```json
{ "id": "…", "team_id": "…", "name": "general", "topic": "", "is_default": true,
  "created_by_member_id": "…", "last_message_seq": 1024, "created_at": "…",
  "pinned": false, "pinned_at": null, "last_read_seq": 1020, "unread_count": 3, "has_unread_mention": true }
```
最后五个字段是**调用者本人**的状态（§5.7），只出现在**用户会话**调用 `GET /teams/{team_id}/channels` 和 `GET /channels/{channel_id}` 的响应里；bot 令牌的响应、`POST/PATCH` 频道的响应、以及 `channel.created` / `channel.updated` 推送里**没有**这几个字段（它们是发给整个 team 的）。列表顺序不变（默认频道在前，再按创建时间）；置顶频道排在前面由前端按 `pinned_at` 自行排序。

### 5.2 消息对象

```json
{
  "id": "0193a1b2-…",
  "seq": 1025,
  "kind": "message",
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
- `kind`：`"message"`（普通消息）或 `"bot_declined"`（bot 声明不回复的提示，§7.7）。前端按 `kind` 渲染：`bot_declined` 显示为系统提示样式，文案由前端拼（如「{sender.display_name} 选择不回复」，`content` 非空时附上原因），挂在 `reply_to` 指向的触发消息下面。普通发消息接口不能指定 `kind`（请求里的 `kind` 字段会被忽略）。
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

- `PATCH /api/v1/messages/{message_id}` `{ "content": "…" }`：仅发送者；重新解析 mentions；推送 `message.updated`；**编辑不触发 webhook，也不触发浏览器推送**。`kind` 不是 `message` 的消息（`bot_declined`）不能编辑 → 403。
- `DELETE /api/v1/messages/{message_id}`：发送者或 owner/admin；软删除 → 204；推送 `message.deleted` `{id, channel_id, seq}`。

### 5.7 未读与置顶（按用户）

已读位置和置顶都按**用户**记录（表 `user_channel_state`，键为 user_id + channel_id），所以同一账号在多个设备 / 标签页之间同步；bot 没有这些状态。

**已读位置与未读数**
- 有效已读位置 = max(用户标记过的 `last_read_seq`, 加入 team 时的 seq)。**加入 team 时视为之前的消息全部已读**：服务端在成员加入时记下当时最新的消息 seq（`team_members.join_seq`）；退出后再加入按新的加入时间算。上线这个版本时，已有成员全部视为已读（迁移把 `join_seq` 设为当时的最大 seq）。加入之后才创建的频道，里面的消息都算未读。
- `unread_count`：seq 大于有效已读位置、**未删除**、`kind = "message"`、且**不是自己发的**消息条数。**最多计到 1000**（≥1000 时返回 1000，前端显示 "999+" 即可）。
- `has_unread_mention`：上述未读消息里有没有 @ 我（基于 mentions 里我的 member_id）。
- 自己发消息时，服务端把自己的已读位置推进到这条消息（相当于发完自动已读），并给自己推 `channel.read`。
- 已读位置**只前进不后退**。

`POST /api/v1/channels/{channel_id}/read`（用户会话；非成员 404，bot 403）
```json
// 请求（body 可省略：省略或不带 seq = 标到频道最新一条）
{ "seq": 1025 }
// 200
{ "channel_id": "…", "team_id": "…", "pinned": false, "pinned_at": null,
  "last_read_seq": 1025, "unread_count": 0, "has_unread_mention": false }
```
- `seq` 必须 ≥ 0（否则 400 `validation_failed`）；大于频道最新 seq 时按最新算（seq 全局递增，不能预先把未来的消息标成已读）；比当前位置小时不变（仍返回当前状态）。
- 位置有变化时，给**本人所有连接**推 `channel.read`（data 同响应体），用于多设备同步；没变化不推。

`PUT /api/v1/channels/{channel_id}/pin` / `DELETE /api/v1/channels/{channel_id}/pin`（用户会话；非成员 404，bot 403）
- 幂等：重复置顶保持原来的 `pinned_at`；取消未置顶的频道也是 200。响应体同上（`pinned: true/false`、`pinned_at`）。
- 状态有变化时，给**本人所有连接**推 `channel.pinned`（data 同响应体）；其他成员看不到。

`GET /api/v1/me/unread`（用户会话）→ 所有 team 中 `unread_count > 0` 或 `has_unread_mention` 的频道（没有未读的频道不出现），用于 team 图标上的红点：
```json
{ "items": [ { "channel_id": "…", "team_id": "…", "pinned": false, "pinned_at": null,
               "last_read_seq": 1020, "unread_count": 3, "has_unread_mention": true } ] }
```

**前端维护未读的建议**：进入 team 时用频道列表的字段初始化；收到 `message.created` 时，如果 `kind == "message"`、不是自己发的、不是当前正在看的频道，则 `unread_count + 1`，`mentions` 里有自己的 member_id 则 `has_unread_mention = true`；正在看的频道收到新消息时调 `POST /read`。收到 `channel.read` / `channel.pinned` 时直接用 data 覆盖该频道的状态。`message.deleted` 不会推送新的未读数，需要精确值时重新拉列表。断线重连后重新拉频道列表。

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
X-TeAms-Message-Id: <message.id>              （仅 message.mention，下同）
X-TeAms-Channel-Id: <channel.id>
X-TeAms-Sender-Member-Id: <sender.member_id>
X-TeAms-Sender-Type: user | bot
X-TeAms-Trigger-Depth: <message.trigger_depth>
<secret_header_name>: <SECRET_HEADER_VALUE>   （若配置）
```

签名：`hex(HMAC-SHA256(signing_secret, timestamp + "." + raw_body))`。接收方应校验签名并拒绝时间戳偏差 > 5 分钟的请求。

Payload（**发送时**根据最新数据生成；消息在发送前被删除则该投递放弃）。**字段顺序固定**，如下所示：标识和路由信息在前，长文本 `content_plain` 在 `message` 的最后，接收方即使截断请求体也能先拿到 `event`、`delivery_id`、`loop_guard`、`sender`、`channel` 和 `message.id`。JSON 不做 HTML 转义（`<@id>` 原样输出，不会变成 `\u003c@id\u003e`）。

**`message` 里只有 `content_plain`，没有原始 `content`**：@ 的对象从 `message.mentions`（`member_id/type/display_name`）读取；需要原始 `<@id>` 文本时用 bot 令牌调消息接口取。消息接口和 WebSocket 里的消息对象仍然带 `content`，不受影响。
```json
{
  "event": "message.mention",
  "delivery_id": "…",
  "sent_at": "…",
  "loop_guard": { "trigger_depth": 0, "max_trigger_depth": 3, "reply_depth_will_be": 1 },
  "sender":  { "member_id": "…", "type": "user", "user_id": "…", "bot_id": null, "username": "creteper",
               "display_name": "Creteper", "avatar_url": null, "avatar_shape": null, "avatar_color": null },
  "channel": { "id": "…", "name": "general" },
  "message": { "id": "…", "seq": 1025, "reply_to": null, "trigger_depth": 0, "created_at": "…",
               "mentions": [ … ], "attachments": [ { "id": "…", "kind": "image", "mime_type": "image/png", "size_bytes": 1,
               "file_name": "a.png", "width": 1, "height": 1, "url": "https://…/content?exp=…&sig=…" } ],
               "content_plain": "@Grok 帮我总结" },
  "reply": { "method": "POST", "url": "https://…/api/v1/channels/<channel_id>/messages",
             "auth": "Authorization: Bearer <BOT_TOKEN>",
             "body_hint": { "content": "<@<sender_member_id>> …", "reply_to": "<message_id>" },
             "decline": { "method": "POST", "url": "https://…/api/v1/messages/<message_id>/decline",
                          "body_hint": { "reason": "（可选，≤200 字）" } },
             "history": { "method": "GET",
                          "url": "https://…/api/v1/channels/<channel_id>/messages?before=<message.seq>&limit=50" } },
  "team":    { "id": "…", "name": "TeAms 开发组", "icon_url": null },
  "bot":     { "id": "…", "member_id": "…", "name": "grok", "display_name": "Grok",
               "avatar_url": "https://…/api/v1/avatars/…", "avatar_shape": "squircle", "avatar_color": "#5865F2" }
}
```
URL 均为基于 `TEAMS_PUBLIC_BASE_URL` 的绝对地址。`reply.decline` 是"声明不回复"的调用方式（§7.7）；`reply.history` 是"拉触发消息之前的历史"的调用方式（GET，带 `before=<message.seq>&limit=50`，用 bot 令牌）。两者都追加在 `reply` 对象末尾，不影响前面字段的顺序。ping 只含 `event/delivery_id/sent_at/team/bot`（按此顺序），不带 `X-TeAms-Message-Id` 等消息相关请求头。

**载荷不带上下文消息**：payload 只有触发消息本身。bot 需要上下文（例如上面的公告）时，用自己的 bot 令牌调 `GET /api/v1/channels/{channel_id}/messages?before=<message.seq>&limit=N`（即 `reply.history.url`），继续往前翻页、读单条、回复、编辑删除等见 [§8.6 bot 怎么自己查看历史和发消息](#86-bot-怎么自己查看历史和发消息)。

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
| `bot.run.declined` | 该 bot 调 `POST /messages/{trigger_message_id}/decline` 声明不回复（§7.7） | `decline_message_id`, `reason`（可空） |

`reason`：`no_webhook` / `timeout` / `network_error` / `http_error` / `invalid_url`，另有 `message_deleted`（发送前触发消息被删）。
状态存在投递记录里；`completed` 和 `declined` 都是终态，之后到达的 delivered/retrying 不会覆盖它们；声明不回复之后 bot 仍可回复（消息正常发出），但状态保持 `declined`、不再发 `bot.run.completed`。`declined` 时 `GET /bot-runs` 的 `reply_message_id` 是那条提示消息的 id。

`GET /api/v1/channels/{channel_id}/bot-runs?active=true`（成员，含 bot）→
```json
{ "items": [ { "delivery_id": "…", "team_id": "…", "channel_id": "…", "bot_member_id": "…", "trigger_message_id": "…",
  "status": "retrying", "attempt": 1, "next_retry_at": "…", "reason": "http_error", "status_code": 503,
  "reply_message_id": null, "started_at": "…", "updated_at": "…" } ] }
```
`active=true`：状态为 started/delivered/retrying 且 10 分钟内创建的（最多 100 条，旧的在前）——页面刷新后恢复"处理中"状态用。不带 `active`：最近 50 条（新的在前）。

### 7.7 Bot 声明不回复

bot 被 @ 后可以明确表示"这条不回复"。TeAms 会在频道里插入一条提示消息（所有人可见、实时推送、刷新后仍在），把该次运行标记为 `declined`，频道里的"正在处理…"随之结束。

**为什么用单独的接口，而不是 webhook 的响应体**：webhook 的接收方（例如 Grok Bot 的 webhook 地址）会在 bot 真正处理之前就返回 2xx，响应内容不由 bot 控制；所以"不回复"必须由 bot 处理完后用自己的令牌主动调接口声明，和发回复消息是同一条路径。

`POST /api/v1/messages/{message_id}/decline`（**仅 bot 令牌**；`message_id` 是 webhook 里的 `message.id`，即触发消息）
```bash
curl -X POST "https://teams.lovekaifa.com/api/v1/messages/<message_id>/decline" \
  -H "Authorization: Bearer <BOT_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"reason": "这个问题不在我的服务范围内"}'
```
- body 可省略；`reason` 可选，去掉首尾空白后 0–200 字，不能含控制字符（超长 → 400 `validation_failed`）。
- **201** → 新建的提示消息（Message，`kind: "bot_declined"`，`sender` 是该 bot，`reply_to` = 触发消息，`content` = reason 或 `""`，`mentions` 恒为空，`trigger_depth` 恒为 0）。同时推送 `message.created`（data 为这条提示消息）和 `bot.run.declined`（§7.6）。
- 重复调用幂等：**200** + 同一条提示消息，不重复推送（第二次的 reason 不会覆盖第一次）。
- 这条消息没有 @ 该 bot（没有对应的 `message.mention` 投递记录）→ **403 `not_mentioned`**。
- 已经回复过（运行状态 `completed`）→ **409 `already_replied`**。
- 消息不存在、已删除、所在频道已删除或不在该 bot 的 team → **404**。用户会话调用 → 403。

提示消息的特殊规则：不解析 @（reason 里写 `<@id>` 只是文本，不进 `mentions`）、**不触发 webhook**、**不触发浏览器推送**、**不计入未读数**、不计入防循环深度（`trigger_depth` 为 0，也不影响触发消息的深度）、**不能编辑**（403），可以像普通消息一样被删除（发送者 bot 或 owner/admin）。

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
| `POST /api/v1/messages/{id}/decline` | 声明不回复（§7.7） |
| `GET /api/v1/teams/{team_id}/members/{member_id}` | 单个成员资料 |
| `POST /api/v1/teams/{team_id}/attachments`、`GET /api/v1/attachments/{id}`、`POST /api/v1/attachments/urls` | |
| 所属团队的 Issue 列表、详情、创建、修改、归档、评论读取、选项读取和 Issue 附件上传 | 见 §8.8 |
| `GET /api/v1/ws` | |

其它接口 → 403。用法示例见 §8.6。

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

### 8.6 bot 怎么自己查看历史和发消息

webhook 只推送触发消息（§7.2）。上下文、历史、回复都由 bot **用自己的令牌**调普通消息接口完成，权限和普通成员一样，但**只限 bot 所在的 team**：别的 team 的 team / 频道 / 消息 / 成员一律 404（不暴露是否存在）。下面的命令可以直接照抄，把 `<BOT_TOKEN>`、`<channel_id>` 等换成实际值（`channel_id`、`message.id`、`message.seq`、`sender.member_id` 都在 webhook payload 里）。

```bash
BASE=https://teams.lovekaifa.com
AUTH="Authorization: Bearer <BOT_TOKEN>"
```

**0. 我是谁、在哪个 team**
```bash
curl -s "$BASE/api/v1/bots/me" -H "$AUTH"        # → {bot, member, team}，team.id 用于下面的 team 级接口
```

**1. 拿到 webhook 后，拉触发消息之前的 N 条**（不含触发消息本身；N ≤ 100）
```bash
curl -s "$BASE/api/v1/channels/<channel_id>/messages?before=<message.seq>&limit=20" -H "$AUTH"
```
返回列表信封 `{ "items": [Message…], "next_cursor": "1001", "has_more": true }`：
- `items` 一律按 `seq` **升序**（旧的在前），最后一条就是紧挨着触发消息的那条；已删除的消息也在里面，带 `deleted: true`、`content: ""`，按需跳过。
- 每条是完整的 Message（§5.2）：`content` 是原始文本（@ 是 `<@member_id>`），@ 的显示名看 `mentions`，发送者看 `sender`（当前显示名），`kind` 为 `bot_declined` 的是"某 bot 选择不回复"的提示。
- `reply.history.url` 就是这条请求（`limit=50`），可以直接用。

**2. 继续往更早翻页**：把上一页的 `next_cursor`（= 本页最小 seq）作为新的 `before`，直到 `has_more: false`。
```bash
curl -s "$BASE/api/v1/channels/<channel_id>/messages?before=<next_cursor>&limit=50" -H "$AUTH"
```
往新的方向用 `after=<seq>`（返回 seq 大于它的最早 N 条，`next_cursor` = 本页最大 seq）；不带 `before/after` 返回最新 N 条。`before` 和 `after` 不能同时用（400）。

**3. 读单条**（例如 `message.reply_to` 指向的那条）
```bash
curl -s "$BASE/api/v1/messages/<message_id>" -H "$AUTH"
```

**4. 回复并 @ 对方**
```bash
curl -s -X POST "$BASE/api/v1/channels/<channel_id>/messages" -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"content":"<@<sender.member_id>> 收到，周五停机前我会提醒大家","reply_to":"<message.id>","client_msg_id":"<delivery_id>"}'
```
→ 201 Message（同一个 `client_msg_id` 24 小时内重发返回 200 和原消息，重试安全，§5.4）。`reply_to` 必须是同一频道的消息，否则 400。回复触发消息会把运行状态标为完成（§7.6）。

**5. 编辑 / 删除自己的消息**
```bash
curl -s -X PATCH "$BASE/api/v1/messages/<my_message_id>" -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"content":"更正：停机改到周六"}'
curl -s -X DELETE "$BASE/api/v1/messages/<my_message_id>" -H "$AUTH"      # → 204
```
只能改 / 删 bot **自己发的**消息；别人的消息 → 403（bot 不是 admin，不能删别人的）。编辑不会再触发 webhook。

**6. 列频道**
```bash
curl -s "$BASE/api/v1/teams/<team_id>/channels" -H "$AUTH"          # 不分页，默认频道在前
curl -s "$BASE/api/v1/channels/<channel_id>" -H "$AUTH"
```
bot 令牌拿到的 Channel 没有未读 / 置顶字段（那是按用户的）。bot 不能建频道、改频道。

**7. 查成员**
```bash
curl -s "$BASE/api/v1/teams/<team_id>/members?type=user&limit=100" -H "$AUTH"
curl -s "$BASE/api/v1/teams/<team_id>/members/<member_id>" -H "$AUTH"
```
成员列表默认 100、最多 200，翻页用 `cursor=<next_cursor>`；单个成员查询对已退出的成员也返回（`deleted: true`），便于解析旧消息里的 `<@id>`。

**分页与限制汇总**

| 接口 | limit 默认 / 上限 | 分页字段 |
|---|---|---|
| `GET /channels/{id}/messages` | 50 / 100（超过 100 按 100；`limit` 非正整数 → 400 `field: "limit"`） | `before` / `after`（seq）、`next_cursor`、`has_more` |
| `GET /teams/{id}/members` | 100 / 200 | `cursor`、`next_cursor`、`has_more` |
| `GET /teams/{id}/channels` | 不分页 | — |

频率限制（§11）：
- **bot 令牌请求总配额：每个 bot 每分钟 120 次**（滑动窗口，按 bot 计，同一 bot 的所有令牌请求共用）。计入：**所有 GET**（频道、消息列表、单条消息、成员、`/bots/me`、附件信息等）以及 **`PATCH` / `DELETE /api/v1/messages/{id}`**（编辑、删除消息）。
- **发消息不计入**这 120 次，仍是每 bot 每频道 30 条/分钟；`PATCH /bots/me` 和头像另有 6 次/分钟；`POST /messages/{id}/decline`、上传附件、`POST /attachments/urls` 不计入；WebSocket 连接（`GET /ws`）和公开的 GET（附件内容 `/attachments/{id}/content`、头像 `/avatars/{id}`、`/healthz`）不计入。
- 超出 → `429 rate_limited`，`Retry-After: <秒>`（到最早一次请求滑出窗口为止，向上取整），错误体与其它错误相同：`{"error":{"code":"rate_limited","message":"请求过于频繁",…}}`。收到 429 请按 `Retry-After` 等待后再试，不要立即重试。
- 用户会话不受这条限制。
- 建议按需拉取（例如每次被 @ 只拉一两页），不要轮询——实时消息请用 WebSocket（§9）或 webhook。

### 8.7 Bot 接入 skill 下载（自托管 npm 包）

给要接入 TeAms 的 AI agent 用的说明书 `teams-bot-integration/SKILL.md`（接入步骤、webhook 载荷、bot 令牌接口、什么时候该 / 不该调用、防循环、排障），连同安装它的 npm 包 `teams-skill` 一起 **go:embed 进后端二进制**，随后端版本发布；**不发布到 npm 公共仓库**（`package.json` 里 `"private": true`，不影响 npx 从 tgz 地址安装）。以下接口都**不需要登录**（不带令牌即可；带 bot 令牌也不计入 §8.6 的 120 次/分钟）。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/skill` | 设置页用的元信息（JSON，`Cache-Control: no-cache`）；`?include=skill_md` 时多返回 `skill_md` 原文 |
| GET | `/api/v1/skill/SKILL.md` | SKILL.md 原文，`text/markdown; charset=utf-8`，`no-cache`，带 `ETag` |
| GET | `/api/v1/downloads/teams-skill.tgz` | **固定地址**，始终是当前后端里的最新版；`Cache-Control: no-cache`（每次用 `ETag` 重新验证） |
| GET | `/api/v1/downloads/teams-skill-<version>.tgz` | **带版本号**的地址；`Cache-Control: public, max-age=31536000, immutable`。只有当前版本可下载，其它版本号（含旧版本）→ 404 `not_found` |

线上完整地址：`https://teams.lovekaifa.com/api/v1/skill`、`https://teams.lovekaifa.com/api/v1/skill/SKILL.md`、`https://teams.lovekaifa.com/api/v1/downloads/teams-skill.tgz`、`https://teams.lovekaifa.com/api/v1/downloads/teams-skill-<version>.tgz`。tgz 响应：`Content-Type: application/gzip`、`Content-Disposition: attachment; filename="teams-skill-<version>.tgz"`、`ETag: "<sha256>"`、`X-TeAms-Skill-Version: <version>`；支持 `If-None-Match`（304）、HEAD 和 Range。

`GET /api/v1/skill` →
```json
{
  "name": "teams-skill",
  "version": "1.1.0",
  "install_command": "npx -y https://teams.lovekaifa.com/api/v1/downloads/teams-skill.tgz",
  "tgz_url": "https://teams.lovekaifa.com/api/v1/downloads/teams-skill.tgz",
  "versioned_url": "https://teams.lovekaifa.com/api/v1/downloads/teams-skill-1.1.0.tgz",
  "skill_md_url": "https://teams.lovekaifa.com/api/v1/skill/SKILL.md",
  "sha256": "<tgz 的 sha256，hex>",
  "size_bytes": 12994,
  "skill_name": "teams-bot-integration",
  "install_path": ".cursor/skills/teams-bot-integration/SKILL.md",
  "skill_md_sha256": "<SKILL.md 的 sha256，hex>"
}
```
- 所有 URL 都由 `TEAMS_PUBLIC_BASE_URL` 拼出（本地开发是 `http://127.0.0.1:8090/...`）。`sha256` 是 tgz 文件本身的 SHA-256，两个下载地址返回同一份字节。
- `install_command` 带 `-y`，免去 npx 的"是否安装"确认（AI agent 在非交互终端里也不会卡住）。
- 嵌入的包损坏时（不应发生，测试会拦住）这几个接口返回 `503 skill_unavailable`。

**安装器（`teams-skill` 的 bin，Node 18+，无依赖）**

```bash
npx -y https://teams.lovekaifa.com/api/v1/downloads/teams-skill.tgz                 # → ./.cursor/skills/teams-bot-integration/SKILL.md
npx -y https://teams.lovekaifa.com/api/v1/downloads/teams-skill.tgz --force         # 已存在时覆盖（更新）
npx -y https://teams.lovekaifa.com/api/v1/downloads/teams-skill.tgz --dir ./agent   # → ./agent/SKILL.md
npx -y https://teams.lovekaifa.com/api/v1/downloads/teams-skill.tgz --version       # 打印版本
```
- 默认目标相对**当前目录**：`./.cursor/skills/teams-bot-integration/SKILL.md`，目录不存在会创建。
- `--dir <目录>`：把 `SKILL.md` 放到这个目录下（写 `<目录>/SKILL.md`，不是把 `<目录>` 当文件名）。
- 目标已存在且没加 `--force`：不覆盖，stderr 提示「已存在，未覆盖。要更新请加 --force」，退出码 **1**；参数错误退出码 **2**；成功 0。
- `--help` / `-h`、`--version` / `-v`。

> **接口一改，就要同步更新 SKILL.md 并重新打包**：本文档里与 bot 相关的接口、字段、限流、webhook 载荷有任何变化，都要同时改 `backend/skill/teams-bot-integration/SKILL.md`、升 `backend/packages/teams-skill/package.json` 的版本号、`npm run dist` 重新生成 tgz 并一起提交（流程见 deploy.md「Bot 接入 skill 包」）。`go test ./skill/` 会在 SKILL.md 改了但没重新打包、或版本号不一致时失败。

---

### 8.8 团队 Issue 与归档

以下路径以 `/api/v1/teams/{team_id}` 为前缀。用户会话与该团队 bot 均可操作。跨团队请求返回 404。

| 方法和路径 | 请求与响应 |
|---|---|
| `GET /issue-options` | 团队状态和标签的 `{kind,name,color}` 列表 |
| `POST /issue-attachments` | multipart 字段 `file`，201 返回附件元数据 |
| `POST /issues` | 必填 `id`（UUID）、`title`（1–240 字）、`status`（团队状态名）、`priority`（none、urgent、high、medium、low）。选填 Markdown `description`（最多 32000 字）、`labels`（标签名数组）、`assignee_id`（在职成员 ID 或 null）、`start_date/end_date`（YYYY-MM-DD 或 null）、`attachment_ids`。201 返回 Issue，同一创建人用原 ID 重试不会重复创建 |
| `GET /issues` | 默认列出活动 Issue，`?archived=true` 只列归档 Issue，标准列表响应 |
| `GET /issues/{id}` | 200 返回完整 Issue，包括 Markdown 标题和描述、创建人、分配人、状态、优先级、标签、排期、附件、创建时间及 `archived_at`（活动时为 null） |
| `PATCH /issues/{id}` | `{field,value}` 支持 title、status、priority、assignee、add_label、remove_label。排期传 `{field:"schedule",start_date,end_date}`，两端可为 null。200 返回更新后的 Issue |
| `PATCH /issues/{id}/description` | `{previous,description}`，成功 204。原文冲突返回 409 |
| `GET /issues/{id}/comments` | 列出评论、回复及其附件，含 `root_id` 和 `reply_to_id` |
| `POST /issues/{id}/archive` | 无需请求体，200 返回归档后的 Issue。重复调用保留首次归档时间 |

用户会话另可用 `GET /api/v1/me/issues` 查看分配给自己的活动 Issue，`?archived=true` 查看个人归档。用户给活动 Issue 发评论或回复用 `POST /issues/{id}/comments`，传 `{id,body,reply_to_id,attachment_ids}`，成功返回 201。归档与写入串行化，归档后修改字段、描述、发评论或回复均返回 409。详情、讨论与附件继续按原团队权限读取。下载附件先取 `GET /api/v1/attachments/{id}`，向返回的签名 URL 添加 `download=1` 可按原文件名下载。

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
| `message.created` / `message.updated` | Message（注意 `kind`，`bot_declined` 不计未读） | team |
| `message.deleted` | `{id, channel_id, seq}` | team |
| `channel.created` / `channel.updated` | Channel | team |
| `channel.deleted` | `{id}` | team |
| `member.joined` | Member | team（加入者本人除外） |
| `member.updated` | Member | team，含本人（改昵称、上传/清除头像、bot 资料变化、角色变化；清除时本来就没头像、或角色设成原值时不推） |
| `member.left` | `{member_id}` | team（离开者本人除外） |
| `team.joined` | Team（含 my_member_id / my_role） | **仅**被加入的用户，之后自动订阅 |
| `team.updated` | Team | team |
| `team.removed` | `{team_id}` | **仅**被移出/退出的用户，之后取消订阅 |
| `team.deleted` | `{team_id}` | team |
| `bot.run.*` | 见 §7.6（含 `bot.run.declined`） | team |
| `channel.read` | `{channel_id, team_id, pinned, pinned_at, last_read_seq, unread_count, has_unread_mention}` | **仅本人**（该用户的所有连接）；已读位置前进时（标记已读、自己发消息） |
| `channel.pinned` | 同上 | **仅本人**；置顶 / 取消置顶时 |

没有 presence / typing 事件。断线重连后用 `GET /channels/{id}/messages?after=<最后 seq>` 补拉。

### 9.4 浏览器推送（Web Push，关掉网页也能收到）

已开启通知的浏览器在 TeAms 页面保持连接时，也会根据实时消息显示本机通知。在线提醒和 Web Push 使用相同的消息 tag。Chrome 关闭全部 TeAms 页面后依赖服务器连通 FCM。

标准 Web Push（RFC 8030 / 8291 加密 / 8292 VAPID）。频道有新消息时，向该 Team 中已订阅通知的其他在组用户发送提醒，包括正在查看该频道的人。真人和 bot 发出的普通消息均可触发。编辑消息、`bot_declined` 提示不触发推送。服务器没配置 VAPID（§13）时推送关闭，其他功能不受影响。

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/api/v1/push/vapid-public-key` | 用户会话 | `{ "enabled": true, "public_key": "<base64url>" }`；未配置时 `{ "enabled": false, "public_key": null }` |
| POST | `/api/v1/push/subscriptions` | 用户会话（bot 403） | body 为浏览器 `PushSubscription.toJSON()`：`{ "endpoint": "https://…", "expirationTime": null, "keys": { "p256dh": "…", "auth": "…" } }` → 新建 **201** / 已存在 **200**，`{id, endpoint, created_at, updated_at}`；未配置推送 → **503 `push_disabled`** |
| DELETE | `/api/v1/push/subscriptions?endpoint=<urlencoded>` | 用户会话 | 也可用 JSON body `{ "endpoint": "…" }`；只删自己的，**总是 204**；缺 endpoint → 400 |

- 订阅按 `endpoint` upsert，绑定到**当前用户和当前登录会话**：同一浏览器换账号登录后再订阅会转到新账号；**退出登录（或会话过期）时该会话的订阅自动删除**，避免退出后仍收到通知。每个用户最多保留 20 个订阅（超出删最旧的）。
- 校验：`endpoint` 必须是 `https://` 公网地址（拒绝内网/本机，同 §7.5；仅 `TEAMS_ENV=dev` + `TEAMS_WEBHOOK_ALLOW_INSECURE_LOCAL=true` 时放宽）；`keys.p256dh` 为 65 字节 P-256 公钥、`keys.auth` 为 16 字节，base64url（有无 `=` 均可）。不合法 → 400 `validation_failed`（`details.field` 为 `endpoint` / `keys.p256dh` / `keys.auth`）。
- 发送：发消息请求提交后**异步**发送，不阻塞发消息；TTL 24 小时、`Urgency: high`、单次超时 10 秒、不重试。推送服务返回 **404 / 410**（订阅已失效）时自动删除该订阅；其它错误只记日志（日志只有订阅 id 和推送服务域名，不记 endpoint 全文和密钥）。

Service Worker 收到的 JSON（解密后）：
```json
{ "type": "mention",
  "tag": "msg-<message_id>",
  "team":    { "id": "…", "name": "TeAms 开发组" },
  "channel": { "id": "…", "name": "general" },
  "sender":  { "member_id": "…", "display_name": "Creteper", "avatar_url": "/api/v1/avatars/…" },
  "message": { "id": "…", "seq": 1025, "excerpt": "@Tina 帮我看一下这个接口…" },
  "url": "/teams/<team_id>/channels/<channel_id>?msg=<message_id>" }
```
- `type` 为 `mention` 时表示接收者被 @，其他接收者收到 `message`。
- `excerpt`：正文里的 `<@id>` 换成 `@显示名`，连续空白压成一个空格，超过 100 个字符（按 Unicode 字符，不切坏汉字）截断并加 `…`；只有附件没有文字时为 `"[附件]"`。
- `url` 是前端路由的相对路径（`/teams/:teamId/channels/:channelId`，`msg` 为要定位的消息 id），点击通知时 `clients.openWindow(url)` / 聚焦已有窗口后导航过去。`tag` 可直接用作 `showNotification` 的 tag。`sender.avatar_url` 是相对路径（可空）。

---

## 10. 头像与 Team 图标

### 10.1 上传
- 用户：`PUT /api/v1/me/avatar`；Team：`PUT /api/v1/teams/{id}/icon`；Bot：`PUT /api/v1/bots/{id}/avatar`、`PUT /api/v1/bots/me/avatar`；multipart 字段 `file`。
- 只接受 jpeg / png / gif / webp（按文件内容嗅探，不看扩展名和 Content-Type），≤ 5 MB（默认值，`TEAMS_MAX_AVATAR_BYTES`），宽、高各 ≤ 4096 像素。服务端**不裁剪不缩放**，超过 4096 直接拒绝（前端如需支持大图，先在浏览器里缩放再上传）。
- 错误码：不是 `multipart/form-data` → 415；缺 `file` 字段 → 400 `validation_failed`（`field: "file"`）；空文件 → 400（`field: "avatar"`）；超过大小上限 → 413 `payload_too_large`（`details.max_bytes`）；不是上述格式 / 解不开 → 415 `unsupported_media_type`；宽或高 > 4096 → 400 `validation_failed`（`field: "avatar"`，「图片尺寸不能超过 4096×4096」）。
- 用户头像改动后推 `member.updated`（§1、§9.3）；`DELETE` 没有头像时也返回 200。
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
| bot 令牌读取 / 编辑 / 删除 | 每 bot 120 次/分钟：所有 GET + `PATCH`/`DELETE /messages/{id}`；发消息不计入（§8.6） | — |
| webhook 触发 | 每 bot 每频道 10 次/60 秒（超出记 skipped_rate_limited） | `TEAMS_WEBHOOK_RATE_PER_MINUTE` |

IP 取连接地址；只有来自本机回环的请求（即 Caddy 反代）才信任 `X-Forwarded-For` / `CF-Connecting-IP`。限流在进程内存中，单实例有效。

## 12. 健康检查

`GET /api/v1/healthz` → `{"status":"ok"}`；数据库不可用 → 503 `{"status":"db_unavailable"}`。

## 13. 配置（环境变量）

见 `backend/.env.example`（全部为占位符）。关键项：`TEAMS_ENV`（`dev`/`production`，默认 production）、`TEAMS_HTTP_ADDR`（默认 `127.0.0.1:8090`）、`TEAMS_PUBLIC_BASE_URL`、`TEAMS_DATABASE_URL`、`TEAMS_SECRET_KEY`（≥32 字节随机，用于加密 webhook 密钥与签名附件 URL）、`TEAMS_UPLOAD_DIR`、`TEAMS_CORS_ORIGINS`、`TEAMS_WEBHOOK_ALLOW_INSECURE_LOCAL`。数据库迁移在启动时自动执行。

浏览器推送（§9.4）：
| 变量 | 说明 |
|---|---|
| `TEAMS_VAPID_PUBLIC_KEY` | VAPID 公钥（P-256，65 字节，base64url），会通过 `GET /push/vapid-public-key` 下发给浏览器 |
| `TEAMS_VAPID_PRIVATE_KEY` | VAPID 私钥（32 字节，base64url），**机密**，只放服务器的 env 文件 |
| `TEAMS_VAPID_SUBJECT` | 联系方式，`mailto:…` 或 `https://…` |

三项都不设 = 推送关闭（服务照常启动，`enabled: false`）；只设一部分或格式不对 = 启动失败（错误信息不包含密钥）。生成方法见 deploy.md。

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
25. **Webhook payload 字段顺序固定、关键字段进请求头**：顶层顺序为 `event, delivery_id, sent_at, loop_guard, sender, channel, message, reply, team, bot`，`message` 内 `content_plain` 放最后（之前按字母序输出，长消息被接收方截断时会丢掉 `sender` 和 `message.id`）；JSON 不再做 HTML 转义；message.mention 额外带 `X-TeAms-Message-Id`、`X-TeAms-Channel-Id`、`X-TeAms-Sender-Member-Id`、`X-TeAms-Sender-Type`、`X-TeAms-Trigger-Depth` 请求头。字段名和取值不变，签名仍按原始 body 计算。
26. **Webhook payload 的 `message` 去掉 `content`（不兼容变更）**：之前正文发两份（`content` + `content_plain`），长消息体积翻倍；现在只保留 `content_plain`，@ 信息看 `message.mentions`。不做长度截断。只影响 webhook 载荷，消息接口和 WebSocket 的 `content` 不变。读 `message.content` 的接收方要改读 `content_plain`。
27. **频道未读**（§5.7）：新增 `POST /channels/{id}/read`（只前进不后退，不传 seq = 标到最新）、`GET /me/unread`；用户会话读取频道列表 / 单个频道时，每个频道多 `last_read_seq`、`unread_count`（最多 1000）、`has_unread_mention`；新增仅本人的 WS 事件 `channel.read`。加入 team 前的消息视为已读，上线时已有成员全部视为已读；自己发的、已删除的、`bot_declined` 消息不算未读；自己发消息会推进自己的已读位置。迁移 `0004_member_profile_unread_pin.sql`。
28. **频道置顶（按用户）**（§5.7）：新增 `PUT / DELETE /channels/{id}/pin`（幂等）；频道多 `pinned`、`pinned_at`；新增仅本人的 WS 事件 `channel.pinned`。列表顺序不变，置顶排序由前端做。
29. **浏览器推送**（§9.4）：新增 `GET /push/vapid-public-key`、`POST / DELETE /push/subscriptions`；只在被 @ 时推送（自己 @ 自己、bot、编辑不推）；订阅绑定登录会话，退出登录即删除；404/410 自动清理。新增环境变量 `TEAMS_VAPID_PUBLIC_KEY`、`TEAMS_VAPID_PRIVATE_KEY`、`TEAMS_VAPID_SUBJECT`（§13）。迁移 `0005_push_subscriptions.sql`。
30. **成员资料**：新增 `GET /teams/{team_id}/members/{member_id}`（含已退出成员，`deleted: true`）；Member 对象新增 `description`（bot 的描述，用户为 null）。
31. **Bot 声明不回复**（§7.7）：新增 `POST /messages/{id}/decline`（仅 bot 令牌）；消息对象新增 `kind`（`message` / `bot_declined`）；运行状态新增终态 `declined` 和事件 `bot.run.declined`；webhook payload 的 `reply` 末尾新增 `decline` 提示（其它字段与顺序不变）；`bot_declined` 消息不能编辑。迁移 `0006_bot_decline.sql`。
32. **修改成员角色时角色没变不再推送**（§3）：`PATCH /teams/{team_id}/members/{member_id}` 设成和当前相同的角色仍返回 200 Member，但不再写库、不再推 `member.updated`（之前每次都推）。其它规则不变，并补全了权限表：admin 可以升降其他 admin、可以把自己降为 member；owner 改自己或改 bot → 403；role 非法 → 400 `field: "role"`；成员不存在 → 404；没有 409。
33. **删除频道后，其消息的附件也不能再访问**（§5.1）：之前频道删掉后，附件仍能通过 `GET /attachments/{id}`、`/content`、签名 URL、`POST /attachments/urls` 取到；现在与频道内消息一致返回 404 / 放进 `missing`。
34. **文档补充（行为未变）**：频道名规则（去首尾空白、1–64 字符、只禁控制字符、不区分大小写唯一、409 `field: "name"`）、频道改名/删除权限表（默认频道可改名不可删、创建者可改名不可删）、软删除细节（§5.1）；`/me/avatar` 的 `member.updated` 推送、`DELETE` 幂等、字段名 `file`、各错误码、超过 4096 直接拒绝不缩放（§1、§10.1）；`member.updated` 的触发场景（§9.3）。
35. **Bot 用自己的令牌查看历史和发消息**（§8.6，新增文档节）：核对并测试了 bot 令牌可以列频道、按 `before` / `after` 分页读消息、读单条（`GET /messages/{id}`）、带 `reply_to` 和 @ 发消息、编辑删除自己的消息、查成员列表和单个成员；这些接口原本就支持，权限限于 bot 所在 team（别的 team → 404，改删别人的消息 → 403）。webhook 载荷**不**携带上下文消息，需要上下文时 bot 自己拉（§7.2）。
36. **webhook payload 的 `reply` 末尾新增 `history`**：`{ "method": "GET", "url": ".../channels/<channel_id>/messages?before=<message.seq>&limit=50" }`，即"拉触发消息之前的历史"的调用方式；`reply` 原有字段和顶层字段顺序不变。
37. **bot 令牌请求限流**（§8.6、§11）：每个 bot 每分钟最多 120 次，计入 bot 令牌的所有 GET 请求和编辑 / 删除消息（`PATCH` / `DELETE /messages/{id}`）；超出返回 `429 rate_limited` + `Retry-After`（秒，向上取整）。发消息仍按每 bot 每频道 30 条/分钟单独计算、不占这 120 次；用户会话不受影响。之前文档写的"读取不限流"作废。
38. **Bot 接入 skill 下载**（§8.7）：新增公开接口 `GET /api/v1/skill`（版本、`install_command`、`tgz_url`、`versioned_url`、`skill_md_url`、`sha256` 等；`?include=skill_md` 带原文）、`GET /api/v1/skill/SKILL.md`、`GET /api/v1/downloads/teams-skill.tgz`（固定地址，`no-cache`）和 `GET /api/v1/downloads/teams-skill-<version>.tgz`（`immutable`）。SKILL.md 与 npm 包 `teams-skill`（`npx -y <tgz 地址>` 写到 `./.cursor/skills/teams-bot-integration/SKILL.md`，支持 `--dir`、`--force`、`--help`、`--version`）go:embed 进后端二进制，随后端发布，不发布到 npm。路径都在 `/api/` 下，nginx 不用改。今后 bot 相关接口有变化时，必须同步更新 SKILL.md、升版本并重新打包。

## QA 卡片和 Issues webhook

`POST /api/v1/channels/{channel_id}/messages` 接受用户或 bot 令牌，`qa_card` 消息沿用 `client_msg_id` 幂等、`reply_to` 和 @ 通知。例子如下。

```json
{"qa_card":{"recipient_member_id":"<本团队成员 id>","questions":[{"prompt":"选择时间","options":["周一","周二"]},{"prompt":"补充说明","options":[]}]}}
```

卡片包含 1–64 道题，每题 0–4 个自定义选项（A–D），另有自填项 `other`。问题上限 500 字，选项上限 160 字，自填答案上限 2000 字。读取消息返回 `qa_card.revision` 和各题的可选 `answer`。提交答案会向团队广播包含最新卡片的 `message.updated`。

`PUT /api/v1/messages/{message_id}/qa-answer` 接受 `{"question":0,"choice":"A"}`、`{"question":0,"choice":"other","text":"…"}` 或 `{"question":0,"choice":"skip"}`。仅绑定成员可写。真人可回填跳过的题；Agent 必须按顺序作答。成功返回完整消息，相同答案重试保持同一 revision。bot 发卡后，每次答案变动通过其 webhook 投递 `qa.answered`，`data` 含 message_id、channel_id、question、revision 和 complete。

管理员配置 bot webhook 时可传布尔字段 `issues_enabled`。默认关闭，更新时省略保留原值。bot 可通过 `PUT /api/v1/bots/me/issue-webhook` 和 `{"enabled":true}` 或 `false` 修改自己的 Issues 订阅。事件 `issue.created`、`issue.updated`、`issue.commented`（含回复）和 `issue.archived` 复用已有签名和重试机制。载荷包含 event、delivery_id、sent_at、team、bot、data；用 data.issue_id 查阅详情，评论事件另有 data.comment_id。
