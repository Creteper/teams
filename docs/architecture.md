# TeAms 后端架构

> 技术栈：Go 1.26、PostgreSQL 18。前后端分离，同一仓库：`frontend/`（Tina）、`backend/` 和 `docs/`（Gus）。接口细节见 [api.md](./api.md)，部署见 [deploy.md](./deploy.md)。本文描述**第二阶段已实现**的结构。

## 1. 总览

```
浏览器 (frontend, Vite dev :5190；生产为 Caddy 静态文件)
   │  REST /api/v1/*        WS /api/v1/ws
   ▼
teams-server  (Go, 127.0.0.1:8090)
   ├─ httpapi     路由 + 全部 handler（auth/teams/members/invites/channels/messages/uploads/bots/bot-runs/ws）
   ├─ webhook     投递队列 worker、HMAC 签名、重试、运行状态回调
   ├─ realtime    WebSocket hub（按 team 扇出 / 按主体定向）
   ├─ netguard    出站 HTTP 安全拨号（webhook 与远程头像共用）
   ├─ storage     文件存储（本地磁盘）
   └─ push        （httpapi/push.go）Web Push 发送：@ 提及时异步推给浏览器推送服务
   │
   ├──► PostgreSQL（业务数据 + webhook 投递队列）
   ├──► 本地磁盘 TEAMS_UPLOAD_DIR（附件、头像）
   ├──► 出站 HTTPS → 浏览器推送服务（FCM / Mozilla / WNS 等，endpoint 由浏览器给出）
   └──► 出站 HTTPS → Bot webhook（如 Grok Bot）
                         │
Bot 处理后  ─────────────┘  POST /api/v1/channels/{id}/messages (Bearer <BOT_TOKEN>, reply_to=触发消息)
                            或 POST /api/v1/messages/{id}/decline（声明不回复）
                            需要上下文时先 GET /api/v1/channels/{id}/messages?before=<seq>（同一令牌，api.md §8.6）
```

单进程部署；状态全在 PostgreSQL 和上传目录里，进程可随时重启（投递队列不丢）。限流器和 WS hub 在进程内存中，因此**只支持单实例**。

## 2. 目录结构

```
backend/
├── cmd/teams-server/main.go      # 入口：读 .env（或 TEAMS_ENV_FILE）→ 连库 → 迁移 → worker + 清理 + HTTP，优雅退出
├── cmd/vapidgen/main.go          # 生成 VAPID 密钥对，只打印到终端（不写文件）
├── migrations/                   # 0001_init … 0006_bot_decline.sql（embed 进二进制，按文件名顺序执行）
├── internal/
│   ├── config/                   # 环境变量解析与校验（LoadDotEnv、FromLookup）
│   ├── db/                       # pgxpool、迁移执行器（schema_migrations + advisory lock）
│   ├── apierr/                   # 统一错误类型与 code
│   ├── auth/                     # argon2id、令牌生成（tas_ / tab_ 前缀）与 SHA-256 哈希
│   ├── mention/                  # <@uuid> 解析与 content_plain 渲染
│   ├── netguard/                 # IP 黑名单、URL 校验、安全 http.Client（每跳重定向重新校验）
│   ├── secretbox/                # 由 TEAMS_SECRET_KEY 派生加密子密钥（AES-GCM）和签名子密钥（HMAC）
│   ├── ratelimit/                # 内存滑动窗口限流
│   ├── media/                    # 文件头嗅探（含 mp4/mov ftyp）、分类、图片尺寸
│   ├── storage/                  # LocalDisk：原子写入（临时文件 + rename）、key 校验
│   ├── realtime/                 # Hub / Client / Event
│   ├── webhook/                  # Sign/Verify、Send、Worker、RunReason
│   └── httpapi/                  # server.go（中间件、鉴权模式）、views.go（JSON 视图与查询）、
│                                 # teams.go、invites.go、messages.go、uploads.go、bots.go、botruns.go、ws.go、routes.go、
│                                 # channelstate.go（未读/置顶）、push.go（Web Push）、decline.go（bot 声明不回复）
│                                 # skill.go（skill 下载接口）
│                                 # *_test.go：集成测试（teams_test 库）
├── skill/                        # Bot 接入 skill：teams-bot-integration/SKILL.md（唯一源文件）+ dist/teams-skill-<version>.tgz，go:embed 进二进制
├── packages/teams-skill/         # 自托管 npm 包（private，不发布）：bin 把 SKILL.md 写到 ./.cursor/skills/…；npm run dist 打包到 skill/dist/
├── .env.example                  # 配置模板（只有占位符）
└── go.mod
```

依赖：`jackc/pgx/v5`、`coder/websocket`、`google/uuid`（UUIDv7）、`golang.org/x/crypto`（argon2id）、`golang.org/x/image`（webp 尺寸）、`SherClockHolmes/webpush-go`（Web Push 加密与 VAPID 签名）。路由用标准库 `net/http` 方法+路径模式。

## 3. 数据表

| 表 | 关键列 | 说明 |
|---|---|---|
| `users` | id, username(唯一, 不区分大小写), password_hash, display_name, avatar_id | |
| `sessions` | token_hash, user_id, expires_at, last_used_at | 只存令牌 SHA-256；滑动续期 |
| `avatars` | id, owner_kind, owner_id, mime_type, sha256, storage_key, source_url | 用户头像、team 图标、bot 头像共用；不可变，换图即新行 |
| `teams` | id, name, description, icon_avatar_id, owner_user_id, deleted_at | |
| `team_members` | id(=member_id), team_id, type(user/bot), user_id / bot_id, role, left_at, **join_seq** | 统一成员身份；(team,user) 在职唯一；`join_seq` 由 BEFORE INSERT 触发器写入加入时的最大消息 seq（加入前的消息视为已读） |
| `bots` | id, team_id, member_id, name, display_name, description, avatar_id, avatar_source_url, avatar_shape, avatar_color, token_hash, deleted_at | 样式字段原样存储 |
| `bot_webhooks` | bot_id, url, enabled, secret_header_name, secret_header_value_enc, signing_secret_enc | 密钥 AES-GCM 加密 |
| `channels` | id, team_id, name(team 内唯一), topic, is_default, deleted_at | |
| `messages` | id, seq(identity), **kind**(message/bot_declined), team_id, channel_id, sender_member_id, content, reply_to, trigger_depth, client_msg_id, edited_at, deleted_at | 索引 (channel_id, seq)；(sender, channel, client_msg_id) 非唯一索引 + 24h 窗口查重 |
| `message_mentions` | message_id, member_id, position | |
| `attachments` | id, team_id, uploader_member_id, message_id(可空), kind, mime_type, size_bytes, storage_key, sha256, width, height | 未引用 24h 后清理 |
| `team_invites` | id, team_id, code(唯一, 10 位 base62), expires_at, max_uses, uses, revoked_at, created_by | |
| `webhook_deliveries` | id, bot_id, message_id, channel_id, event, status, attempts, next_attempt_at, last_status_code, last_error, **run_status, run_reason, reply_message_id, run_updated_at** | 投递队列 + 投递日志 + bot 运行状态（run_status 含 `declined`）；保留 7 天 |
| `user_channel_state` | (user_id, channel_id), last_read_seq, pinned_at, updated_at | 按用户的已读位置与置顶；跨设备同步 |
| `push_subscriptions` | id, user_id, session_id(会话删除即级联删除), endpoint(唯一), p256dh, auth, last_success_at, last_error | 浏览器推送订阅，每用户最多 20 个 |

## 4. 配置（环境变量）

完整列表见 `backend/.env.example`（占位符）。真实值只放 `backend/.env`（已被 .gitignore 忽略，权限 600）或生产的 `/etc/teams/teams.env`。

| 变量 | 默认 | 说明 |
|---|---|---|
| `TEAMS_ENV` | `production` | `dev` 才允许开发开关 |
| `TEAMS_HTTP_ADDR` | `127.0.0.1:8090` | 只监听回环 |
| `TEAMS_PUBLIC_BASE_URL` | `http://127.0.0.1:8090` | 生成 webhook payload 里的绝对 URL |
| `TEAMS_DATABASE_URL` | — | `postgres://teams_app:<DB_PASSWORD>@127.0.0.1:5432/teams_dev?sslmode=disable` |
| `TEAMS_TEST_DATABASE_URL` | — | 集成测试库 `teams_test`（只被 `go test` 使用） |
| `TEAMS_SECRET_KEY` | — | 正好 32 字节随机，base64 编码（`openssl rand -base64 32`），丢失则 webhook 密钥无法解密、附件签名失效 |
| `TEAMS_UPLOAD_DIR` | `./data/uploads` | |
| `TEAMS_CORS_ORIGINS` | `http://localhost:5190,http://127.0.0.1:5190` | 逗号分隔；同时用于 WS Origin 校验 |
| `TEAMS_WEBHOOK_ALLOW_INSECURE_LOCAL` | `false` | 仅 `TEAMS_ENV=dev` 生效：允许 http 和本机/内网 webhook 与头像地址 |
| `TEAMS_SESSION_TTL` | `720h` | |
| `TEAMS_MAX_IMAGE_BYTES` / `_VIDEO_BYTES` / `_AVATAR_BYTES` | 10MB / 100MB / 5MB | |
| `TEAMS_MAX_TRIGGER_DEPTH` | 3 | |
| `TEAMS_WEBHOOK_RATE_PER_MINUTE` | 10 | 每 bot 每频道 |
| `TEAMS_WEBHOOK_TIMEOUT` / `TEAMS_WEBHOOK_WORKERS` | 10s / 4 | |
| `TEAMS_AUTH_RATE_PER_MINUTE` / `TEAMS_INVITE_PREVIEW_RATE_PER_MINUTE` | 20 / 30 | 每 IP |
| `TEAMS_LOG_LEVEL` | `info` | |
| `TEAMS_VAPID_PUBLIC_KEY` / `TEAMS_VAPID_PRIVATE_KEY` / `TEAMS_VAPID_SUBJECT` | 空（推送关闭） | Web Push；三项须同时设置，私钥机密，用 `go run ./cmd/vapidgen` 生成 |

端口：用户 Mac 上 3000 是 zhw AI 客服、5173 等已占用，后端选 **8090**；前端开发端口 **5190**。

本地数据库：Homebrew PostgreSQL 18 上的专用角色 `teams_app`（NOSUPERUSER / NOCREATEDB / NOCREATEROLE），库 `teams_dev`、`teams_test` 归它所有。

## 5. 请求处理与鉴权

中间件：request id → recover → CORS（白名单）→ handler。每个路由声明访问模式：`public` / `userOnly` / `botOnly` / `anyAuth`。令牌按前缀区分会话（`tas_`）和 bot（`tab_`），查哈希得到 principal（`user:<id>` 或 `bot:<id>`）。团队内权限由 `team_members` 角色判断；不可见资源返回 404。

客户端 IP：连接地址；仅当连接来自回环（Caddy 反代）时信任 `X-Forwarded-For` / `CF-Connecting-IP`。

## 6. 消息发送流程

单事务：
1. `client_msg_id` → `pg_advisory_xact_lock(发送者+频道+id)`，24h 内已存在则返回原消息（200）。
2. 校验 `reply_to` 同频道，计算 `trigger_depth`（§9）。
3. 解析 `<@uuid>`，只保留本 team 在职成员。
4. 插入消息、mentions，认领附件（必须本人上传、未被引用）。
5. 若发送者是 bot 且带 `reply_to`：把该 bot 由触发消息产生的运行标记为 `completed`。
6. 为被 @ 的 bot 写投递记录（防循环、限流、无 webhook → `failed/no_webhook`）。

提交后：推送 `message.created`、`bot.run.completed`、`bot.run.started` / `bot.run.failed(no_webhook)`，唤醒 worker；用户发送时把自己的已读位置推进到这条消息并给自己推 `channel.read`；有 @ 用户时异步发浏览器推送（§7.1）。

### 6.2 未读计数

一条 SQL（`channelStateSQL`）算出用户在一个 team（或单个频道、或全部 team）每个频道的状态：有效已读位置 `eff = max(user_channel_state.last_read_seq, team_members.join_seq)`；`unread_count` 为 `seq > eff`、未删除、`kind='message'`、非本人发送的消息数，用 `LIMIT 1000` 子查询封顶（走 `(channel_id, seq)` 索引，只扫未读部分）；`has_unread_mention` 从 `message_mentions(member_id)` 索引出发做 EXISTS。选 `join_seq`（触发器写入）而不是"加入时给每个频道插已读行"，是因为成员加入有多个入口（建 team、按用户名添加、邀请），触发器一处覆盖；也不用 `created_at <= joined_at` 现算，因为那需要每次倒扫加入后的全部消息。

### 6.1 seq 与提交顺序

问题：`messages.seq` 是全局 identity，值在 `INSERT` 时取得，但要到事务提交才对读者可见。两个并发事务 A（seq 10）、B（seq 11）若 B 先提交，客户端 `after=9` 拿到 11 后游标前移到 11，A 随后提交的 10 就永远不会被 `after=` 补拉到（漏消息）。

做法：发送事务在 `INSERT messages` 之前执行

```sql
SELECT 1 FROM channels WHERE id = $1 AND deleted_at IS NULL FOR UPDATE;
```

同一频道的发送因此串行：seq 只在持有频道行锁之后才取号，锁在提交（或回滚）时释放；PostgreSQL 先让事务提交可见、再释放行锁，所以下一个事务取到的 seq 一定大于所有已可见的同频道消息。**同一频道内 seq 顺序 = 可见顺序**，`after=<seq>` 补拉不漏不重。频道在发送途中被删除时锁不到行，返回 404。

锁顺序固定为：`client_msg_id` advisory lock → 频道行锁 → 各 bot 的 webhook 限流 advisory lock，其它路径不会反向持有，所以不会死锁。

取舍：
- **选行锁而不是每频道 `last_seq` 计数器列**：计数器（`UPDATE channels SET last_seq = last_seq + 1 RETURNING`）同样要锁频道行，并发度相同，但会把 seq 变成"频道内序号"，需要改列、迁移旧数据、并改变 API 中"seq 全局单调"的语义；行锁方案零迁移、接口不变。
- **代价**：同一频道的发送被串行化，锁持有时间 = 从取锁到提交（插入消息、mentions、认领附件、写投递记录，通常几毫秒）。单频道吞吐上限约为每秒数百条，对聊天场景足够；不同频道之间互不影响。
- 不同频道之间的 seq 仍可能与提交顺序不一致，这没有影响，因为游标总是按频道使用。WS `ready.last_seq` 只作参考，补拉应按频道用 `after=`。
- 并发集成测试 `TestSeqConcurrentCatchUp`（8 个发送者 × 40 条，夹杂另一频道的消息，另有读者不停 `after=` 补拉）验证不漏、不重、seq 严格递增；去掉这把锁时该测试每次都会漏 1–3 条。

## 7. 实时推送

- 连接注册到 Hub，订阅其所在 team 集合；`PublishTeam` 扇出，`PublishTeamExcept` 排除某主体，`PublishPrincipal` 定向。
- 加入 team：`SetTeam(主体, team, true)` 后给本人发 `team.joined`；其他人收 `member.joined`。移出/退出：先取消订阅，再给 team 发 `member.left`、给本人发 `team.removed`。
- 每个连接有 256 帧发送缓冲，满了即踢掉（客户端重连后按 seq 补拉）。
- 无 presence / typing。
- 个人事件 `channel.read` / `channel.pinned` 用 `PublishPrincipal("user:<id>")` 只发给本人的所有连接（多设备同步）。

### 7.1 浏览器推送（Web Push）

- 发消息提交后，若 mentions 里有用户成员（排除发送者自己），起一个 goroutine：查这些用户的订阅 → 生成 payload（team/频道/发送人/摘要/跳转 url）→ 每个订阅用 webpush-go 加密（RFC 8291）并带 VAPID JWT（RFC 8292）POST 到 endpoint。全局并发上限 8，单次 10 秒超时，TTL 24 小时，不重试。
- 出站客户端与 webhook 同一套 `netguard` 策略（连接时校验 IP、不走代理、不跟随重定向）；订阅时 endpoint 也做同样的 URL 校验。
- 404/410 → 删除订阅；其它失败只写 `last_error` 和日志（只记订阅 id 与 endpoint 域名）。
- 订阅绑定登录会话（`session_id` 外键级联），退出登录或会话过期时一并删除。

## 8. 文件存储

- `storage.LocalDisk`：key 形如 `attachments/<team>/<yyyy>/<mm>/<id>`、`avatars/<id>`，写临时文件后 rename；key 有字符白名单，不含用户文件名。
- 附件流式上传，边写边计 SHA-256，超限删除；内容嗅探决定类型。
- 附件 URL：`/api/v1/attachments/<id>/content?exp=&sig=`，`sig = base64url(HMAC-SHA256(sign_key, "att|" + id + "|" + exp))`，1 小时有效。
- 头像公开、不可变（`Cache-Control: immutable`），更换即生成新 id。远程头像下载一次转存，同 URL 同 SHA-256 不重复保存。
- 每小时清理：未引用附件（24h）、孤儿头像（1h）、旧投递日志（7d）、过期会话。

## 9. 防循环设计

- `trigger_depth`：人 = 0；bot 带 `reply_to` = 父 depth + 1；bot 不带 = 1。仅 depth ≤ `TEAMS_MAX_TRIGGER_DEPTH` 的消息触发。
- 频率：同一 bot 同一频道 60 秒内最多 N 次，在事务内用 `pg_advisory_xact_lock(bot+频道)` 串行计数，避免并发超发。
- bot @ 自己忽略；编辑不触发。
- 跳过的投递以 `skipped_depth` / `skipped_rate_limited` 记录，不推送运行事件。

## 10. Webhook 投递 worker 与 bot 运行状态

- N 个 goroutine（默认 4）：`UPDATE … WHERE id IN (SELECT … WHERE status='pending' AND next_attempt_at<=now() ORDER BY next_attempt_at LIMIT 5 FOR UPDATE SKIP LOCKED) SET next_attempt_at = now()+租约(2 分钟)` 领取；入队时 `Wake()`，否则每秒轮询。崩溃后租约到期自动重新领取。
- **发送时**生成 payload（最新 bot 资料、新签名附件 URL）；消息已删除则放弃（`failed`，运行 reason `message_deleted`）。
- 签名 `X-TeAms-Signature = sha256=hex(HMAC(signing_secret, ts + "." + body))`，加配置的密钥头。
- HTTP 客户端：`netguard` 安全拨号（连接时校验 IP，防 DNS rebinding）、每跳重定向重新校验、不使用环境代理、10 秒超时。
- 结果：2xx → `succeeded`；5xx/429/超时/网络错误 → 10s/60s/300s（±20% 抖动）后重试，共 4 次；其它 → `failed`。`last_error` 只记错误类别（`http_503`、`timeout`…），不记响应体。

运行状态机（`run_status`，存在投递行上）：

```
入队 ──► started ──2xx──► delivered ──bot 回复 reply_to──► completed
            │                 ▲
            ├─可重试失败─► retrying ─┘(重试成功)
            └─最终失败 / 无 webhook ─► failed
任意非终态 ──bot 回复──► completed
任意非终态 ──bot 调 /messages/{id}/decline──► declined（插入 kind=bot_declined 的提示消息，reply_message_id 指向它）
completed / declined 是终态，之后不再被覆盖（worker 的 setRun 与 completeRuns 都跳过终态）
```

每次状态变化通过 worker 的 `Notify` 回调推送 `bot.run.*` 给整个 team。`GET /channels/{id}/bot-runs?active=true` 读 started/delivered/retrying 且 10 分钟内的行。

## 11. 邀请

- code：`crypto/rand` 生成 10 位 base62（约 59.5 bit），唯一约束冲突时重试。
- 接受：单事务 `SELECT … FROM team_invites … FOR UPDATE`，判断已是成员（直接返回、不计数）→ 失效原因（revoked > expired > exhausted）→ 插入成员 → `uses = uses + 1`。并发接受同一 `max_uses=N` 的邀请，最多 N 人成功（有并发测试）。
- 预览接口公开，按 IP 限流。

## 12. 安全要点

- 密码 argon2id；令牌只存哈希；webhook 密钥 AES-GCM 加密且只写不读；签名密钥只在创建/轮换时返回一次。
- 日志、错误、投递记录里不出现令牌和密钥。
- 后端只监听 127.0.0.1；公网暴露只通过反向代理（见 deploy.md），5432 / 8090 永不对外。
- 上传按内容嗅探、限大小、`nosniff`，文件名不进路径。
- 出站请求 SSRF 防护；`198.18.0.0/15` 故意放行（Clash fake-ip），生产服务器上没有 fake-ip 时这一段本来就不可路由。
- 开发开关 `TEAMS_WEBHOOK_ALLOW_INSECURE_LOCAL` 只在 `TEAMS_ENV=dev` 生效。

## 13. 测试

- 单元测试：mention、netguard、webhook 签名/分类、secretbox、media 嗅探、ratelimit、auth、config、storage、realtime、样式字段规范化、trigger_depth、邀请码。
- 集成测试（`internal/httpapi`）：未读/已读/置顶与 `channel.read`/`channel.pinned`、成员资料、Web Push（测试里模拟浏览器生成 ECDH 密钥，按 RFC 8291 解密校验 payload；覆盖被 @、自己 @ 自己、未 @、410/404 删除订阅、退出登录删订阅）、bot 声明不回复；`TestMain` 重建 `teams_test` 的 public schema 并迁移；`httptest` 起完整路由，本地 `httptest.Server` 当 webhook 接收器（`AllowInsecureLocal` 仅测试中打开）。覆盖注册→team→频道→消息分页→WS 事件→@bot→验签→bot 回复→深度/限流跳过→重试/失败→bot 运行事件→邀请（含并发）→team 修改/退出→附件签名刷新→bot 资料与头像。
- 命令：`go vet ./...`、`go build ./...`、`go test -race ./...`（需要 `TEAMS_TEST_DATABASE_URL`，从 `backend/.env` 读取）。
