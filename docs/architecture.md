# TeAms 后端架构

> 技术栈：Go 1.26、PostgreSQL 18（本机 Homebrew，专用库 `teams`）。前后端分离，同一仓库：`frontend/`（Tina）、`backend/` 和 `docs/`（Gus）。接口细节见 [api.md](./api.md)，部署见 [deploy.md](./deploy.md)。

## 1. 总览

```
浏览器 (frontend, Vite dev :5173 → 代理)
   │  REST /api/v1/*        WS /api/v1/ws
   ▼
teams-server  (Go, 127.0.0.1:8090)
   ├─ httpapi     路由、中间件（鉴权、CORS、限流、request id、错误格式）
   ├─ auth        注册/登录、会话令牌、bot 令牌校验
   ├─ teams       team、成员、角色
   ├─ channels    频道
   ├─ messages    发送/分页/编辑/删除、mention 解析、trigger_depth 计算
   ├─ attachments 上传校验、存储、签名 URL
   ├─ avatars     用户头像 / team 图标 / bot 头像（上传或远程拉取转存）
   ├─ bots        bot 管理、令牌轮换、webhook 配置
   ├─ webhook     投递队列 worker、签名、重试、防循环
   ├─ realtime    WebSocket hub（按 team 扇出事件）
   └─ storage     文件存储接口（本地磁盘；可替换对象存储）
   │
   ├──► PostgreSQL（数据 + webhook 投递队列）
   ├──► 本地磁盘 TEAMS_UPLOAD_DIR
   └──► 出站 HTTPS → Grok Bot webhook
                         │
Grok Bot 处理后  ───────┘  POST /api/v1/channels/{id}/messages (Bearer <BOT_TOKEN>)
```

单进程部署即可满足第一版；所有状态在 PostgreSQL 和上传目录里，进程可随时重启。

## 2. 目录结构（计划）

```
backend/
├── cmd/teams-server/main.go      # 入口：读配置、连库、跑迁移、启动 HTTP + worker
├── internal/
│   ├── config/                   # 环境变量解析与校验
│   ├── db/                       # pgxpool、事务助手、迁移执行器
│   ├── httpapi/                  # 路由（net/http ServeMux 方法+路径模式）、中间件、错误输出
│   ├── auth/                     # argon2id、令牌生成与哈希、会话
│   ├── teams/ channels/ messages/ attachments/ bots/
│   ├── avatars/                  # 头像存储、远程拉取（复用 netguard）
│   ├── netguard/                 # 出站 HTTP 安全拨号（拒绝内网 IP），webhook 与头像拉取共用
│   ├── mention/                  # <@uuid> 解析与 content_plain 渲染
│   ├── webhook/                  # 队列 worker、HMAC、重试、SSRF 防护、限流
│   ├── realtime/                 # WebSocket hub/client
│   ├── storage/                  # Storage 接口 + localdisk 实现
│   ├── secretbox/                # AES-GCM 加解密 webhook 密钥
│   └── apierr/                   # 统一错误类型与 code
├── migrations/                   # 0001_init.sql …（embed 进二进制）
├── .env.example                  # 配置模板（占位符）
└── README.md
```

依赖尽量少：`github.com/jackc/pgx/v5`（数据库）、`github.com/coder/websocket`（WS）、`golang.org/x/crypto/argon2`（密码）、`github.com/google/uuid`（UUIDv7）。路由用标准库 `net/http`。迁移用自写的简单执行器（`schema_migrations` 表 + embed 的 SQL 文件），测试用真实 PostgreSQL 测试库（`teams_test`）。

## 3. 数据表

| 表 | 关键列 | 说明 |
|---|---|---|
| `users` | `id uuid pk`, `username citext unique`, `password_hash`, `display_name`, `avatar_id null`, `created_at` | 人类账号 |
| `sessions` | `id`, `user_id fk`, `token_hash bytea unique`, `expires_at`, `last_used_at`, `created_at`, `user_agent` | 会话令牌（只存 SHA-256） |
| `teams` | `id`, `name`, `description`, `icon_avatar_id null`, `owner_user_id`, `created_at`, `deleted_at` | |
| `team_members` | `id uuid pk`（= member_id）, `team_id fk`, `type ('user'|'bot')`, `user_id null`, `bot_id null`, `role ('owner'|'admin'|'member'|'bot')`, `joined_at`, `left_at` | 统一成员身份；`unique(team_id,user_id)`；check: type 与 user_id/bot_id 一致 |
| `bots` | `id`, `team_id`, `member_id unique`, `name`, `display_name`, `description`, `avatar_id null`, `avatar_source_url`, `token_hash bytea unique`, `token_prefix`, `created_by_member_id`, `created_at`, `deleted_at` | `unique(team_id, lower(name))` |
| `bot_webhooks` | `bot_id pk`, `url`, `enabled`, `secret_header_name`, `secret_header_value_enc bytea`, `signing_secret_enc bytea`, `updated_at` | 密钥 AES-GCM 加密 |
| `channels` | `id`, `team_id`, `name`, `topic`, `is_default`, `created_by_member_id`, `created_at`, `deleted_at` | `unique(team_id, lower(name)) where deleted_at is null` |
| `messages` | `id uuid pk`, `seq bigint identity unique`, `team_id`, `channel_id`, `sender_member_id`, `content text`, `reply_to uuid null`, `trigger_depth smallint`, `client_msg_id`, `created_at`, `edited_at`, `deleted_at` | 索引 `(channel_id, seq)`；`unique(sender_member_id, client_msg_id)` |
| `message_mentions` | `message_id`, `member_id`, `position` | pk(message_id, member_id)；索引 member_id（"提到我的"） |
| `attachments` | `id`, `team_id`, `uploader_member_id`, `message_id null`, `kind ('image'|'video')`, `mime_type`, `size_bytes`, `file_name`, `storage_key`, `sha256`, `width`, `height`, `duration_ms`, `created_at` | 未引用超 24h 由清理任务删除 |
| `webhook_deliveries` | `id`, `bot_id`, `message_id`, `channel_id`, `event`, `status`, `attempts`, `next_attempt_at`, `last_status_code`, `last_error`, `payload jsonb`, `created_at`, `finished_at` | 既是投递队列也是日志；`unique(bot_id, message_id)`；索引 `(status, next_attempt_at)`、`(bot_id, channel_id, created_at)` |
| `avatars` | `id uuid pk`, `owner_kind ('user'|'team'|'bot')`, `owner_id`, `mime_type`, `size_bytes`, `width`, `height`, `sha256`, `storage_key`, `source_url null`, `created_at` | 头像/图标，与消息附件分开；公开读取 |
| `schema_migrations` | `version`, `applied_at` | 迁移记录 |

删除策略：team/频道/bot 软删除（`deleted_at`），消息软删除；硬删由后续管理任务处理。

## 4. 配置（环境变量）

启动时读取进程环境；若存在 `backend/.env`（已 gitignore）则先加载它，进程环境优先。

| 变量 | 默认 | 说明 |
|---|---|---|
| `TEAMS_HTTP_ADDR` | `127.0.0.1:8090` | 监听地址。**只绑回环**，公网暴露交给隧道/反代 |
| `TEAMS_PUBLIC_BASE_URL` | `http://127.0.0.1:8090` | 生成绝对链接（webhook 里的附件 URL、reply url） |
| `TEAMS_DATABASE_URL` | 必填 | `postgres://<DB_USER>:<DB_PASSWORD>@127.0.0.1:5432/teams?sslmode=disable` |
| `TEAMS_SECRET_KEY` | 必填 | 32 字节 base64；用于 AES-GCM 加密 webhook 密钥、签名附件 URL |
| `TEAMS_UPLOAD_DIR` | `./data/uploads` | 本地文件存储根目录 |
| `TEAMS_CORS_ORIGINS` | `http://localhost:5173` | 逗号分隔；同时用于 WS Origin 校验 |
| `TEAMS_SESSION_TTL` | `720h` | 会话有效期 |
| `TEAMS_MAX_IMAGE_BYTES` / `TEAMS_MAX_VIDEO_BYTES` | 10 MiB / 100 MiB | 上传上限 |
| `TEAMS_MAX_AVATAR_BYTES` | 5 MiB | 头像/图标上限 |
| `TEAMS_MAX_TRIGGER_DEPTH` | `3` | 防循环深度上限 |
| `TEAMS_WEBHOOK_RATE_PER_MINUTE` | `10` | 每 bot 每频道每分钟触发上限 |
| `TEAMS_WEBHOOK_TIMEOUT` | `10s` | 单次投递超时 |
| `TEAMS_WEBHOOK_ALLOW_PRIVATE` | `false` | 允许 http 和内网地址的 webhook / 远程头像拉取（仅本地调试） |
| `TEAMS_LOG_LEVEL` | `info` | slog 级别 |

端口选择：2026-11-14 在用户 Mac 上 `lsof -iTCP -sTCP:LISTEN` 检查，3000（zhw AI 客服）、3306、4321、5000、5173、5432、6379、7000、13001 等已占用，**8090 空闲**，选定 8090（8080 也空闲，作为备选）。

## 5. 请求处理与鉴权

- 中间件链：request id → 访问日志（不记录 Authorization、token、密码字段）→ CORS → 鉴权（解析 Bearer，按前缀 `tas_`/`tab_` 区分会话/bot）→ 限流 → handler。
- 权限检查在 service 层：先确认"调用者在该 team 有有效成员身份"，再检查角色；bot 只能访问自己 team，且只允许 api.md §6.3 列出的接口。对无权访问的资源返回 404 而不是 403，避免枚举。
- 令牌：32 字节 crypto/rand，base64url，前缀区分类型；库里存 SHA-256。

## 6. 消息发送流程

在一个数据库事务内：

1. 校验成员身份、频道归属、内容长度、附件（本 team、本人上传、未被引用）。
2. `client_msg_id` 幂等检查。
3. 解析 `<@uuid>` → 查 `team_members`，得到有效 mentions。
4. 计算 `trigger_depth`（见 §9）。
5. 插入 `messages`、`message_mentions`，更新附件 `message_id`。
6. 对每个被 @ 的、配置了 webhook 的 bot，做防循环/限流判断，插入 `webhook_deliveries`（`pending` 或 `skipped_*`）。
7. 提交后：发布 `message.created` 到 realtime hub；`NOTIFY webhook_pending` 唤醒 worker。

## 7. 实时推送

- `realtime.Hub` 维护 `team_id → 连接集合`。连接鉴权后加载用户所在 team 列表并注册。
- 事件在业务事务提交**之后**发布（避免推送了回滚的数据）。
- 每个连接一个有界发送队列（如 256），满了就断开该慢客户端，由其重连补拉。
- 成员加入/移除 team 时更新 hub 订阅。
- 单进程内存 hub 足够第一版；若将来多实例，改为 PostgreSQL `LISTEN/NOTIFY` 或 Redis pub/sub 扇出，hub 接口不变。
- 心跳：服务端 60 秒读超时；客户端 25 秒发 `ping`。
- **不做在线状态**：不记录、不推送 presence/typing，hub 只负责数据变更事件。

## 8. 文件存储

- `storage.Storage` 接口：`Put(ctx, key, reader) / Open(ctx, key) / Delete(ctx, key)`。
- 默认实现 `localdisk`：根目录 `TEAMS_UPLOAD_DIR`，key 形如 `<team_id>/<yyyy>/<mm>/<attachment_id>`（不使用用户文件名，防路径穿越）。
- 上传流程：`http.MaxBytesReader` 限制总大小 → 读前 512 字节 `http.DetectContentType` 嗅探 + 白名单 → 流式写临时文件并计算 sha256 → 原子重命名 → 写 `attachments`。图片尝试读取宽高（标准库 image 解码 config）。
- 下载：`http.ServeContent`（支持 Range），加 `nosniff`。签名 URL = HMAC(`TEAMS_SECRET_KEY`, `attachment_id|exp`)。
- 将来换对象存储（S3/R2/OSS）：实现同一接口，下载改为 302 到对象存储预签名 URL。
- 清理任务每小时删除 24h 未被引用的附件和不再被引用的旧头像。

### 头像 / 图标

- 独立表 `avatars`，文件在 `TEAMS_UPLOAD_DIR/avatars/<avatar_id>`，公开路由 `/api/v1/avatars/{id}`（长缓存）。
- 来源：multipart 上传，或 `avatar_url` 远程拉取（`netguard` 拒绝内网地址、只允许 http/https、10 秒超时、5 MB、最多 3 次重定向、嗅探类型）。
- 同 `source_url` + 同 sha256 视为未变化，不生成新记录、不推送，支持 bot 定时同步。
- 变更后发布 `member.updated` / `team.updated`。
- 前端（Discord 式布局）所需：team 列表带 `icon_url`，成员列表带 `type` 和 `avatar_url`。

## 9. 防循环设计

目标：bot A 和 bot B 互相 @ 时不会无限触发 webhook。

1. **trigger_depth**（消息属性，服务端计算）：
   - 用户发 → 0；
   - bot 发且 `reply_to` 指向同频道消息 → `parent.trigger_depth + 1`；
   - bot 发且无 `reply_to` → 1。
   - 只有 `trigger_depth <= TEAMS_MAX_TRIGGER_DEPTH`（默认 3）才入队 webhook。人发起一次对话，bot 之间最多再接力 3 轮。
   - 绕过考虑：bot 故意不带 `reply_to` 会把深度重置为 1，所以需要第 2 层兜底。
2. **频率限制**：入队前按 `webhook_deliveries` 统计 `(bot_id, channel_id)` 最近 60 秒内非 skipped 的记录数，`>= TEAMS_WEBHOOK_RATE_PER_MINUTE` 则写 `skipped_rate_limited`。在同一事务里对 `(bot_id, channel_id)` 取 `pg_advisory_xact_lock` 保证计数准确。
3. **自 @ 不触发**；`unique(bot_id, message_id)` 保证一条消息只投递一次。
4. bot 发消息频率上限（30 条/分钟/频道）进一步限制失控 bot。
5. 载荷里带 `loop_guard`，让接收方（Grok Bot）也知道当前深度，可自行决定是否继续 @ 其他 bot。

## 10. Webhook 投递 worker

- N 个 goroutine（默认 4）循环：`SELECT … FROM webhook_deliveries WHERE status='pending' AND next_attempt_at <= now() ORDER BY next_attempt_at LIMIT 10 FOR UPDATE SKIP LOCKED`，空闲时等待 `LISTEN webhook_pending` 或 5 秒轮询。
- 发送：载荷在入队时生成并存 `payload`（附件签名 URL 在发送时刷新）；计算 `X-TeAms-Signature = sha256=hex(HMAC(signing_secret, ts + "." + body))`，加配置的密钥头。
- HTTP 客户端：10 秒超时、不跟随重定向、自定义 `DialContext` 在连接时校验目标 IP 非内网/回环/链路本地（防 DNS rebinding 型 SSRF），可由 `TEAMS_WEBHOOK_ALLOW_PRIVATE` 关闭。
- 结果：2xx → `succeeded`；可重试错误 → `attempts+1`，按 10s/60s/300s 退避；4 次后 `failed`。
- 投递记录保留 7 天。

## 11. 安全要点

- 密码 argon2id；令牌只存哈希；webhook 密钥加密存储且只写不读。
- 日志、错误信息、投递记录里不出现令牌和密钥（`last_error` 只记状态码和错误类别）。
- 后端只监听 127.0.0.1；公网暴露通过隧道或反向代理（见 deploy.md）。
- 上传按内容嗅探、限大小、文件名不进路径。
- 登录、注册、发消息、上传都有限流。

## 12. 测试策略

- 单元测试：mention 解析、trigger_depth 计算、HMAC 签名、SSRF 地址判断、配置解析。
- 集成测试：连接专用测试库 `teams_test`（每个测试包跑迁移、每个测试用事务或清表），`httptest` 起完整路由，覆盖注册→建 team→建频道→发消息→WS 收到事件→@bot→本地 `httptest.Server` 收到 webhook（验签）→bot 用令牌回复→深度与限流跳过。
- `go vet` + `go test -race ./...`。
