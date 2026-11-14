---
name: teams-bot-integration
description: 当需要把 AI（含 Grok Bot）自动接入 TeAms、配置 webhook、用 bot 令牌查看或发送消息，或判断某个接口该不该调用时使用。
---

# 把 AI 接入 TeAms

TeAms 是团队聊天网站，公网地址：`https://teams.lovekaifa.com`。有人在频道里 @ 这个 bot，TeAms 会把消息推到 webhook；bot 再用自己的令牌拉历史、回复，或声明不回复。

本 skill 面向任何要接入 TeAms 的 AI agent。令牌、team id、bot id、成员 id 都用占位符；不要把真实密钥写进提示词、聊天、日志或代码库。细节以仓库里的 `docs/api.md` 为准。

---

## 1. 约定

| 项 | 约定 |
|---|---|
| 公网地址 | `https://teams.lovekaifa.com` |
| REST 前缀 | `/api/v1` |
| 鉴权 | `Authorization: Bearer <TOKEN>` |
| 用户会话令牌 | 以 `tas_` 开头，注册 / 登录获得，可管理该用户所在全部 team |
| Bot 令牌 | 以 `tab_` 开头，创建 bot 或轮换时**只返回一次**，只能调所属 team、且仅限下文「接口表」里的接口 |
| 编码 | 请求 / 响应 `application/json; charset=utf-8`；上传用 `multipart/form-data` |
| ID | UUID v7 字符串；@ 用的是 **member_id**，不是 user id 或 bot id |
| 时间 | RFC 3339 UTC |

令牌一律存到权限 `600` 的文件里（例如 `~/.config/teams/bot-token`），只在脚本内部读取，不要打印、不要写进 prompt。泄露后由 owner / admin 调 `POST /api/v1/bots/{bot_id}/token/rotate` 换新，旧令牌立即失效。

错误体统一为：

```json
{ "error": { "code": "validation_failed", "message": "…", "details": { "field": "content" } }, "request_id": "req_…" }
```

每个响应带 `X-Request-Id`。不可见的资源（包括别的 team）统一返回 `404`，不泄露是否存在。列表接口一般是 `{ "items": […], "next_cursor": "…或 null", "has_more": false }`。

---

## 2. 接入步骤

需要 team 的 **owner 或 admin** 用用户会话完成建 bot 和配 webhook。之后 bot 自己用 bot 令牌收消息、回消息。

### 2.1 创建 bot

```bash
BASE=https://teams.lovekaifa.com
SESSION=$(cat "$SESSION_TOKEN_FILE")   # 权限 600，不要 echo

curl -s -X POST "$BASE/api/v1/teams/<team_id>/bots" \
  -H "Authorization: Bearer $SESSION" -H "Content-Type: application/json" \
  -d '{
    "name": "my_bot",
    "display_name": "我的 Bot",
    "description": "一句话说明这个 bot 做什么",
    "avatar_shape": "blob",
    "avatar_color": "violet"
  }'
```

返回 `201 {bot, token, warnings?}`。**立刻**把 `token` 写入权限 600 的文件，然后从终端历史里忘掉它。记下 `bot.id` 和 `bot.member_id`。

- `name`：3–32 位 `[A-Za-z0-9_.-]`，同一 team 内唯一，**不区分大小写**（重名 → 409 `conflict`，`details.field: "name"`）。
- `display_name`：1–64，可省略（省略或空白时等于 `name`）；`description`：≤ 500。
- 远程 `avatar_url` 拉取失败不影响创建，会带 `warnings: [{code:"avatar_fetch_failed", message}]`。

只要填了 `avatar_shape` 或 `avatar_color`，前端就显示动画头像。想和某个 Grok Bot 头像一致，就填同样的形状和颜色。后端对这两个字段**只去掉首尾空白，不转小写、不做枚举校验**（空或 `null` 存为 `null`；长度 ≤ 64，不能含控制字符）。前端目前识别的取值：

- 形状（25 种）：`blob`、`pebble`、`bean`、`egg`、`squircle`、`tablet`、`capsule`、`cylinder`、`hex`、`gem`、`crystal`、`wedge`、`shield`、`dome`、`arch`、`cloud`、`teardrop`、`leaf`、`square`、`sparkle`、`clover`、`flower`、`heart`、`house`、`star`
- 颜色（11 种）：`black`、`brown`、`red`、`orange`、`yellow`、`green`、`cyan`、`blue`、`violet`、`magenta`、`gray`，或十六进制（`#rgb` / `#rgba` / `#rrggbb` / `#rrggbbaa`）
- 前端还认几个别名：颜色 `grey`→`gray`、`purple`→`violet`、`pink`→`magenta`、`teal`→`cyan`；形状 `circle` / `sphere`→`blob`、`hexagon`→`hex`、`spark`→`sparkle` 等。不认识的取值回退到默认（`blob` / `black`）

若前端后来有增减，以当时前端和 `api.md` §8.2 为准。以后改样式：owner / admin 调 `PATCH /api/v1/bots/{bot_id}`，bot 自己调 `PATCH /api/v1/bots/me`。两个字段都清空则回到首字头像。

### 2.2 在 Grok Bot 里建 webhook 任务

在负责这个 bot 的 Grok Bot 里建一个 **webhook 类型的任务（routine）**，收到推送时按第 5、6 节的规则处理。建好后复制两样东西：**webhook 地址**和 **sender key**。sender key 也是密钥，同样只放在权限 600 的文件里。

任务提示词里不要写 bot 令牌。回复、拉历史、声明不回复都由脚本从文件读令牌后调用。

### 2.3 把 TeAms 和接收端连起来

```bash
curl -s -X PUT "$BASE/api/v1/bots/<bot_id>/webhook" \
  -H "Authorization: Bearer $SESSION" -H "Content-Type: application/json" \
  -d '{
    "url": "<Grok Bot 任务的 webhook 地址>",
    "enabled": true,
    "secret_header_name": "Authorization",
    "secret_header_value": "Bearer <SENDER_KEY>"
  }'
```

- `url` 必须是 `https://`，且不能指向本机 / 私网地址（被拦截 → 400，`details.reason: "blocked_address"`）。
- `secret_header_value` **任何接口都不回显**，只返回 `secret_header_set`。
- 首次创建时响应里会带一次 `signing_secret`（`whsec_…`），自建接收端校验 `X-TeAms-Signature` 时用；之后只能轮换。走 Grok Bot 任务时，主要靠上面的 `Authorization: Bearer <SENDER_KEY>` 鉴权。

### 2.4 测试

1. `POST /api/v1/bots/{bot_id}/webhook/test`（用户会话）。返回 `"ok": true, "status_code": 200` 说明接收端收到了 `ping`（应直接忽略，见第 6 节）。`result` 为错误分类，如 `http_500` / `timeout` / `blocked_address` / `network_error`。
2. 在频道里 @ 这个 bot 说一句话，它应按规则回复或声明不回复。
3. 没回就查 `GET /api/v1/bots/{bot_id}/webhook/deliveries`（最近 100 条）。状态含义见第 8 节。

---

## 3. Webhook 载荷

触发条件：消息的 `mentions` 里有该 bot，且不是它 @ 自己。编辑消息**不**触发。普通未 @ 的消息也不会推过来（若要监听全部消息，用 WebSocket，见接口表；默认的 @ 回复流程不需要）。

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
Authorization: Bearer <SENDER_KEY>            （若已按 2.3 配置）
```

签名算法：`hex(HMAC-SHA256(signing_secret, timestamp + "." + raw_body))`。自建接收端应校验签名，并拒绝时间戳偏差大于 5 分钟的请求。

**顶层字段顺序固定**：`event`、`delivery_id`、`sent_at`、`loop_guard`、`sender`、`channel`、`message`、`reply`、`team`、`bot`。`message` 里 `id`、`seq`、`reply_to`、`trigger_depth` 排在正文前面。JSON 不做 HTML 转义（`<@id>` 原样输出）。即便正文很长被接收端截断，也能先看到是谁发的、消息 id 是什么；关键信息同时在 `X-TeAms-*` 请求头里。

**`message` 里只有 `content_plain`，没有原始 `content`。** 正文读 `content_plain`；@ 了谁读 `message.mentions`（`member_id` / `type` / `display_name`）。需要原始 `<@member_id>` 文本时，用 bot 令牌调消息接口取。消息 REST 接口和 WebSocket 里的消息对象仍带 `content`，不受影响。

**载荷不带上下文。** 只有触发消息本身。需要前面的讨论、公告或被回复的那条消息时，必须自己拉历史，不要指望 payload 里会出现 `context` 字段。

`reply` 对象末尾有两个提示，可直接照着调（用 bot 令牌）：

- `reply.decline`：`POST /api/v1/messages/<message_id>/decline`
- `reply.history`：`GET /api/v1/channels/<channel_id>/messages?before=<message.seq>&limit=50`

`ping` 只含 `event`、`delivery_id`、`sent_at`、`team`、`bot`（按此顺序），没有消息相关请求头，收到后直接忽略。

投递超时 10 秒。**2xx 算成功**；5xx / 429 / 超时 / 网络错误会重试（共 4 次：首次 + 10 秒、60 秒、300 秒，±20% 抖动；429 的 `Retry-After` 更长时用它）；其它 4xx 不重试。接收端应尽快返回 2xx，再异步用 bot 令牌回复。重试时用 `X-TeAms-Delivery` 去重；发消息时可把 `delivery_id` 当作 `client_msg_id`，同一发送者、同一频道、24 小时内重复提交会返回原消息（200），不会重复创建、也不会再触发 webhook。

---

## 4. Bot 令牌能调用的接口

以下均可使用 `Authorization: Bearer <BOT_TOKEN>`。权限只限该 bot 所在 team；其它接口 → 403。

| 用途 | 方法与路径 | 关键参数 | 限流 |
|---|---|---|---|
| 自己的资料（含头像字段） | `GET /api/v1/bots/me`（别名 `/api/v1/bot/me`） | 返回 `{bot, member, team}`，`webhook` 恒为 `null` | 计入 120 次/分钟 |
| 改自己的资料 | `PATCH /api/v1/bots/me` | 只允许 `display_name`、`description`、`avatar_url`、`avatar_shape`、`avatar_color` | 与头像共用 6 次/分钟，**不计入** 120 |
| 上传 / 清除自己的头像 | `PUT` / `DELETE /api/v1/bots/me/avatar` | multipart 字段名必须是 `file`；jpeg/png/gif/webp，≤ 5 MB，宽高各 ≤ 4096 | 上传与 `PATCH /bots/me` 共用 6 次/分钟（不计入 120）；清除（`DELETE`）不限流，既不占这 6 次也不计入 120 |
| 列频道 | `GET /api/v1/teams/{team_id}/channels` | 一次返回全部，默认频道在前。bot 拿到的 Channel **没有**未读 / 置顶字段 | 计入 120 |
| 单个频道 | `GET /api/v1/channels/{channel_id}` | 同上 | 计入 120 |
| 拉历史 | `GET /api/v1/channels/{channel_id}/messages` | `limit` 默认 50、最大 100；`before` 或 `after` 为 seq，不能同时用。不带参数 = 最新 N 条。`items` 按 seq **升序**（旧的在前）。`next_cursor` 为 seq 字符串 | 计入 120 |
| 读单条 | `GET /api/v1/messages/{message_id}` | 例如去读 `message.reply_to` 指向的那条 | 计入 120 |
| 发消息 | `POST /api/v1/channels/{channel_id}/messages` | `{content, attachment_ids?, reply_to?, client_msg_id?}`。`content` ≤ 8000 字；正文（去空白后）与附件至少一个非空。@ 语法：`<@member_id>`，最多 20 个在职成员 | **不计入** 120；每 bot 每频道 30 条/分钟 |
| 编辑自己的消息 | `PATCH /api/v1/messages/{message_id}` | `{ "content": "…" }`；重新解析 @；**不**触发 webhook。别人的消息或 `kind=bot_declined` → 403 | 计入 120 |
| 删除自己的消息 | `DELETE /api/v1/messages/{message_id}` | → 204。别人的消息 → 403（bot 不是 admin） | 计入 120 |
| 成员列表 | `GET /api/v1/teams/{team_id}/members` | `?type=user\|bot&limit=&cursor=`；limit 默认 100、最大 200 | 计入 120 |
| 单个成员资料 | `GET /api/v1/teams/{team_id}/members/{member_id}` | 已退出 / 已删除的也能查到（`deleted: true`）；不是本 team → 404 | 计入 120 |
| 声明不回复 | `POST /api/v1/messages/{message_id}/decline` | 仅 bot 令牌。body 可省；`reason` 可选，0–200 字。成功 201；重复调用 200（不覆盖第一次的 reason）；未 @ 该 bot → 403 `not_mentioned`；已经回复过 → 409 `already_replied` | **不计入** 120 |
| team 详情 | `GET /api/v1/teams/{team_id}` | 仅所属 team | 计入 120 |
| 该 team 的 bot 列表 | `GET /api/v1/teams/{team_id}/bots` | 非 owner/admin 看到的 `webhook` 为 `null` | 计入 120 |
| 运行状态 | `GET /api/v1/channels/{channel_id}/bot-runs` | `?active=true` 为处理中；只返回 `{items}` | 计入 120 |
| 上传附件 | `POST /api/v1/teams/{team_id}/attachments` | multipart `file`；图片 jpeg/png/gif/webp ≤ 10 MB，视频 mp4/webm/mov ≤ 100 MB | **不计入** 120 |
| 附件元数据 / 批量刷新签名 | `GET /api/v1/attachments/{id}`、`POST /api/v1/attachments/urls` | 后者 body `{ "ids": ["…"] }`，1–100 个 | GET 计入 120；POST urls **不计入** |
| WebSocket | `GET /api/v1/ws` | 请求头带 bot 令牌；自动订阅自己的 team。客户端约每 25 秒 `{"type":"ping"}` | **不计入** 120 |

120 次/分钟是滑动窗口，按 bot 计（同一 bot 的所有令牌共用），计入**所有 GET**以及编辑 / 删除消息。超出 → `429 rate_limited`，带 `Retry-After`（秒，向上取整，最小 1）。公开的 `GET /attachments/{id}/content`、`GET /avatars/{id}`、`GET /healthz` 不计入。

bot **不能**：建 / 改 / 删频道，标记已读，置顶，收浏览器推送，配 webhook，改别人角色，访问别的 team。

### 4.1 从文件读令牌的调用示例

```python
import json, os, urllib.request, urllib.error
from pathlib import Path

BASE = "https://teams.lovekaifa.com"
TOKEN_FILE = Path(os.environ.get("TEAMS_BOT_TOKEN_FILE", Path.home() / ".config/teams/bot-token"))

def bot_token():
    return TOKEN_FILE.read_text().strip()  # 不要 print

def teams(method, path, body=None, timeout=30):
    data = None if body is None else json.dumps(body, ensure_ascii=False).encode()
    headers = {"Authorization": "Bearer " + bot_token()}
    if data is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(BASE + path, method=method, data=data, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
            return r.status, json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        retry = e.headers.get("Retry-After")
        err = e.read().decode()[:800]
        if e.code == 429:
            raise SystemExit(f"HTTP 429 rate_limited Retry-After={retry}\n{err}")
        raise SystemExit(f"HTTP {e.code}\n{err}")
```

```bash
BASE=https://teams.lovekaifa.com
AUTH="Authorization: Bearer $(cat "$TEAMS_BOT_TOKEN_FILE")"   # 不要先把令牌赋给会 echo 的变量再打印

# 我是谁、在哪个 team
curl -s "$BASE/api/v1/bots/me" -H "$AUTH"

# 需要上下文时：拉触发消息之前的历史（不含触发消息本身）
curl -s "$BASE/api/v1/channels/<channel_id>/messages?before=<message.seq>&limit=20" -H "$AUTH"

# 继续往更早翻页：before=<上一页 next_cursor>，直到 has_more 为 false
# 往新方向：after=<seq>。before 与 after 不能同时用（400）

# 读单条（例如被回复的那条）
curl -s "$BASE/api/v1/messages/<message_id>" -H "$AUTH"

# 回复并只 @ 对方；reply_to 必须是同一频道的消息
curl -s -X POST "$BASE/api/v1/channels/<channel_id>/messages" \
  -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"content":"<@<sender.member_id>> 收到","reply_to":"<message.id>","client_msg_id":"<delivery_id>"}'

# 查成员（@ 之前先确认 member_id）；已退出的成员单个查询也能查到
curl -s "$BASE/api/v1/teams/<team_id>/members?type=user&limit=100" -H "$AUTH"
curl -s "$BASE/api/v1/teams/<team_id>/members/<member_id>" -H "$AUTH"

# 这条不回答
curl -s -X POST "$BASE/api/v1/messages/<message.id>/decline" \
  -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"reason":"这个问题不在我的服务范围内"}'
```

声明不回复后，TeAms 会在触发消息下面插一条 `kind=bot_declined` 的提示（所有人可见）。它不解析 @、不触发 webhook、不发浏览器推送、不计入未读、不计入防循环深度，也不能编辑。声明之后仍可以再发回复，但运行状态保持 `declined`，不会再变为 completed。

---

## 5. 什么时候应该调用

被 @ 之后，按这个顺序做：

1. **先看事件和防循环。** `event` 为 `ping` 就结束。若发送者是 bot，且 `message.trigger_depth` ≥ 4（或 ≥ `loop_guard.max_trigger_depth + 1`，默认上限是 3），不要回复、也不要 decline，直接结束。
2. **需要上下文时再拉历史。** 用 `GET /channels/{channel_id}/messages?before=<message.seq>&limit=N`（可直接用 `reply.history.url`，N ≤ 100）。一次被 @ 通常拉 1–2 页就够。触发消息里的 `reply_to` 若有值，再 `GET /messages/{id}` 把那条读出来。不要把上下文写进 webhook 配置，载荷里也不会带。
3. **决定回答时，用 `reply_to` 回复。** `POST /channels/{channel_id}/messages`，`reply_to` 填触发消息的 `message.id`（也就是 `reply.body_hint`）。不带 `reply_to` 时，新消息的 `trigger_depth` 会变成 1，服务器的防循环会失效。建议 `client_msg_id` 用本次 `delivery_id`，避免 webhook 重试导致重复回复。
4. **@ 只点发送者。** 正文以 `<@sender.member_id>` 开头。member_id 以 payload / `X-TeAms-Sender-Member-Id` 为准；如果要从显示名查找别人，先 `GET .../members` 或 `GET .../members/{id}`，确认是在职成员再 @。不要凭记忆硬编 id。
5. **决定不回答时，调 decline。** 用 `POST /messages/{message.id}/decline`（或 `reply.decline.url`），可选带 `reason`。这样频道里会留下「某 bot 选择不回复」，「正在处理…」也会结束。不要既不回也不声明，让状态一直挂着。
6. **改口或收回时，再编辑 / 删除自己刚发的消息。** 只动自己的。
7. **主动开新话题**（不是在回某条 @）可以不带 `reply_to`；若要 @ 某人，同样先查成员再写 `<@member_id>`。

---

## 6. 什么时候不应该调用

- **忽略 `ping`。** 不要当消息处理，不要回复，不要 decline。
- **发送者是 bot 且 `trigger_depth` ≥ 4 时不要回复**（见第 5 节第 1 步）。这样 bot 与 bot 之间最多两轮。服务器默认也只推送 `depth ≤ 3` 的消息，这条是双重保险。
- **不要 @ 自己。** 服务器也不会把「bot @ 自己」推回来。
- **回复时不要顺带 @ 其他 bot 或不相干的人。** 只 @ 发送者，否则会把更多 bot 拉进对话，或误触发别人。
- **不要为了等新消息去轮询** `GET /channels/{id}/messages`。被 @ 靠 webhook；若确实要听全部消息，用 WebSocket，断线后用 `after=<最后 seq>` 补拉。每次被 @ 不要一口气翻完整段历史。
- **收到 `429` 必须等 `Retry-After` 秒再试**，不要立刻重试。发消息还要遵守每频道 30 条/分钟，不要用多条碎消息刷屏。
- **不要编辑或删除别人的消息**（403）。不要给 `bot_declined` 提示消息做编辑。
- **不要在回复被 @ 的消息时省略 `reply_to`。**
- **不要把 bot 令牌、sender key、signing_secret、会话令牌写进提示词、聊天、日志、页面或 git。** 令牌能读该 team **所有频道的全部历史**，交给外部服务就等于把整个 team 的消息都开放给对方。
- **不要把 webhook 指到本机或私网地址**，生产环境会被拒绝。
- 编辑消息不会触发 webhook，也不会因为新加了 @ 而补推。不要指望靠「改一条旧消息」去叫醒 bot。

---

## 7. 防循环（必须遵守）

`trigger_depth`：人发的消息 = 0；bot 带 `reply_to` 发的 = 父消息 depth + 1；bot 不带 `reply_to` 发的 = 1。只有 `depth ≤ TEAMS_MAX_TRIGGER_DEPTH`（默认 3）的消息才会推给 bot。同一 bot 在同一频道 60 秒内最多触发 10 次（超出记 `skipped_rate_limited`，不推送）。

每个 bot 自己还要遵守：

1. 每次回复被 @ 的消息都带 `reply_to` = 触发消息 id。
2. 发送者是 bot 且深度已经到上限加 1（默认 ≥ 4）时不回复。
3. 只 @ 发送者，不 @ 自己，不顺带 @ 其他 bot。

默认上限下的两轮例子：

| 消息 | 深度 | 会不会再触发 |
|---|---|---|
| 人：@B 去跟 A 打个招呼 | 0 | 推给 B |
| B：@A 你好（第 1 轮） | 1 | 推给 A |
| A：@B 你好（第 1 轮） | 2 | 推给 B |
| B：@A 最近怎样（第 2 轮） | 3 | 推给 A |
| A：@B 挺好（第 2 轮） | 4 | 不再推送，对话结束 |

---

## 8. 排障

### 投递状态（`GET /api/v1/bots/{bot_id}/webhook/deliveries`）

记录保留 7 天。字段：`id, message_id, channel_id, event, status, attempts, last_status_code, last_error, next_attempt_at, created_at, finished_at`（`next_attempt_at` 仅 `pending` 时有值；ping 的 message_id / channel_id 为 null）。

| status | 含义 | 怎么处理 |
|---|---|---|
| `pending` | 正在发送或等待重试 | 等，必要时看 `next_attempt_at` |
| `succeeded` | 接收端返回了 2xx | TeAms 已送达，问题在接收端（任务规则、令牌文件、是否拉了历史） |
| `failed` | 最终失败 | 看 `last_error` 和 `last_status_code` |
| `skipped_depth` | 超过深度上限（默认 3），没有推送 | 正常，对话已到轮次上限 |
| `skipped_rate_limited` | 同一 bot 同一频道 60 秒内触发超过 10 次 | 等一会儿再试 |

投递记录的 `last_error` 和运行状态事件（`bot.run.*`）的 `reason` 是两套取值（以 `api.md` §7.3、§7.6 为准）：

| `last_error`（投递记录） | 对应的 `reason` | 含义 / 怎么处理 |
|---|---|---|
| `no_webhook` | `no_webhook` | 发消息时这个 bot 没配或已停用 webhook（直接记 `failed`），回到第 2.3 步 |
| `webhook_not_configured` | `no_webhook` | 发送时发现 webhook 已删除或停用 |
| `timeout` | `timeout` | 10 秒内没有返回，检查接收端是否及时回 2xx |
| `network_error` | `network_error` | 网络错误，检查接收端是否可达 |
| `http_<状态码>`（如 `http_500`） | `http_error` | 非 2xx，看 `last_status_code`（5xx / 429 会重试，其它 4xx 不会） |
| `blocked_address` | `invalid_url` | 地址被 SSRF 拦截（测试接口的 `result` 里也会出现），不重试 |
| `dropped` | `message_deleted` | 发送前触发消息（或频道、bot）已被删除，无需处理 |
| `build_error` | `network_error` | 服务端生成载荷出错，会重试；持续出现请联系管理员 |
| `skipped_depth` / `skipped_rate_limited` | — | 与 `status` 相同，没有推送（见上表） |

### 常见 HTTP 错误码

| HTTP | code | 常见原因（bot 场景） |
|---|---|---|
| 400 | `bad_request` / `validation_failed` | 参数不合法（看 `details.field`）：空正文、`before` 与 `after` 同时出现、`limit` 非正整数、`reason` 超长或含控制字符等 |
| 401 | `unauthorized` | 令牌缺失、无效或已轮换 |
| 403 | `forbidden` | 令牌类型不对（bot 调了用户接口）；编辑 / 删除别人的消息 |
| 403 | `not_mentioned` | 对一条没有 @ 自己的消息调用 decline |
| 404 | `not_found` | 资源不存在、已删除，或不在该 bot 的 team（含访问别的 team） |
| 409 | `conflict` | 重名等 |
| 409 | `already_replied` | 已经回复过又调用 decline |
| 413 | `payload_too_large` | 上传超限，`details.max_bytes` |
| 415 | `unsupported_media_type` | 文件类型不允许（`details.detected`）或 Content-Type 不对 |
| 422 | `avatar_fetch_failed` | 远程头像拉取失败（`details.reason`） |
| 429 | `rate_limited` | 超过 120 次/分钟或每频道 30 条/分钟，按 `Retry-After` 等待 |
| 500 / 503 | `internal` / — | 服务端错误。未配置浏览器推送时，用户侧订阅接口会 503 `push_disabled`（bot 不用调） |

---

## 9. 安全（再强调一次）

- bot 令牌能读所属 team 所有频道的全部历史。不要交给第三方，不要写进外部 prompt。
- 密钥只放在权限 600 的文件里，只在脚本里读取。
- 轮换令牌用 `POST /api/v1/bots/{bot_id}/token/rotate`（用户会话）。轮换 webhook 签名用 `POST /api/v1/bots/{bot_id}/webhook/signing-secret/rotate`。

---

## 10. 安装 / 更新本 skill

本文件由 TeAms 后端托管，随后端版本发布（Node 18+）：

```bash
npx -y https://teams.lovekaifa.com/api/v1/downloads/teams-skill.tgz            # 写到 ./.cursor/skills/teams-bot-integration/SKILL.md
npx -y https://teams.lovekaifa.com/api/v1/downloads/teams-skill.tgz --force    # 已存在时覆盖（更新）
npx -y https://teams.lovekaifa.com/api/v1/downloads/teams-skill.tgz --dir <目录> # 写到 <目录>/SKILL.md
```

当前版本号、sha256 和原文地址见 `GET https://teams.lovekaifa.com/api/v1/skill`（无需登录）。
