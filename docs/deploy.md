# TeAms 公网部署方案

> **已选方案 B：阿里云服务器 + Caddy**。服务器 IP `123.57.134.175`，域名 `teams.lovekaifa.com`。
> 本文是操作手册，**尚未实施**：本阶段没有连接服务器、没有部署、没有开放任何端口。
> 文中所有口令、令牌、密钥一律是占位符（`<DB_PASSWORD>`、`<TEAMS_SECRET_KEY>` 等），真实值只在部署时生成并写入服务器上的 `/etc/teams/teams.env`，**不进仓库、不进文档、不进聊天记录**。

## 为什么需要公网

- 出站 webhook（TeAms → Grok Bot）只需要服务器能上网。
- 但 Grok Bot 处理完要**回调** TeAms API（`POST /api/v1/channels/{id}/messages`），并下载 webhook 里的附件 URL，所以后端需要 Grok Bot 能访问的 HTTPS 地址（`TEAMS_PUBLIC_BASE_URL`）。
- 团队成员不在同一局域网，前端也要公网访问。

形态：前端静态文件与后端**同域**——`https://teams.lovekaifa.com/` 前端，`/api/v1/*` 后端，`wss://teams.lovekaifa.com/api/v1/ws` WebSocket，浏览器无跨域。

---

## ⚠️ 上线前必读

> **1. ICP 备案是前置条件。** `123.57.134.175` 属于阿里云中国大陆（北京）数据中心。大陆服务器上的域名在**完成 ICP 备案之前**，80/443 的 HTTP(S) 访问会被拦截（显示未备案提示页），Let's Encrypt 的 HTTP 验证也会失败，证书签不下来。
> - 在阿里云「ICP 代备案管理系统」为 `lovekaifa.com` 提交备案（主体信息、域名实名、服务器绑定该 ECS 实例），审核一般 1–3 周。
> - 备案通过、网站上线后 **30 天内**在「全国互联网安全管理服务平台」完成公安联网备案，并在页面底部展示 ICP 备案号（前端页脚，由 Tina 加）。
> - 备案完成前**不要**把 DNS 指过去对外试用；如需提前联调，用下面的备选 C（ngrok，仅临时）。
>
> **2. 安全组（阿里云控制台 → ECS → 安全组，入方向）**
>
> | 端口 | 来源 | 说明 |
> |---|---|---|
> | 80/tcp | 0.0.0.0/0 | HTTP（Caddy 自动跳转 HTTPS、ACME 验证） |
> | 443/tcp | 0.0.0.0/0 | HTTPS + WSS |
> | 443/udp | 0.0.0.0/0 | 可选，HTTP/3 |
> | 22/tcp | **仅运维人员的固定 IP**（如 `<ADMIN_IP>/32`） | SSH；不要对 0.0.0.0/0 开放 |
> | **5432** | **不开放** | PostgreSQL 只监听 127.0.0.1 |
> | **8090** | **不开放** | 后端只监听 127.0.0.1，只由 Caddy 访问 |
>
> 系统内再开 `ufw`（只放行 22/80/443）做第二道防线。
>
> **3. 生产配置必须是：** `TEAMS_ENV=production`，`TEAMS_PUBLIC_BASE_URL=https://teams.lovekaifa.com`，`TEAMS_CORS_ORIGINS=https://teams.lovekaifa.com`（同时是 WebSocket Origin 白名单），`TEAMS_WEBHOOK_ALLOW_INSECURE_LOCAL=false`。
>
> **4. SSH 凭据**：部署时由用户通过**加密卡片**提供（SSH 私钥或一次性口令），只在当次会话使用、不落盘到仓库或文档；部署完成后建议改为仅密钥登录并轮换。本文不包含任何密码。

---

## 方案 B（已选）：阿里云 ECS + Caddy

### B.1 拓扑

```
浏览器 / Grok Bot
   │ https://teams.lovekaifa.com   (443, Let's Encrypt 证书)
   ▼
Caddy (systemd: caddy)
   ├─ /api/*        → reverse_proxy 127.0.0.1:8090   （含 WebSocket /api/v1/ws）
   └─ 其它路径      → /srv/teams/frontend（静态文件，SPA 回退 index.html）
teams-server (systemd: teams，用户 teams，127.0.0.1:8090)
   ├─ PostgreSQL 18 (127.0.0.1:5432，库 teams，角色 teams_app)
   └─ /var/lib/teams/uploads（附件、头像）
```

假设系统为 **Ubuntu 24.04 LTS x86_64**（如是 Alibaba Cloud Linux，把 apt 换成 dnf，其余相同）。建议规格 ≥ 2 vCPU / 2 GB 内存 / 40 GB 云盘；上传多的话单独挂一块数据盘到 `/var/lib/teams`。

### B.2 DNS

在 `lovekaifa.com` 的 DNS 服务商（如阿里云云解析）添加：

| 主机记录 | 类型 | 记录值 | TTL |
|---|---|---|---|
| `teams` | A | `123.57.134.175` | 600 |

验证：`dig +short teams.lovekaifa.com` 应返回 `123.57.134.175`。（备案通过后再添加/生效。）

### B.3 服务器初始化

```bash
# 以有 sudo 权限的运维账号登录（凭据见"上线前必读 4"）
sudo apt update && sudo apt -y upgrade
sudo apt -y install ufw curl ca-certificates gnupg unattended-upgrades
sudo timedatectl set-timezone Asia/Shanghai

# SSH：只用密钥，禁止 root 密码登录
sudo sed -i 's/^#\?PasswordAuthentication .*/PasswordAuthentication no/; s/^#\?PermitRootLogin .*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config
sudo systemctl reload ssh

# 防火墙
sudo ufw default deny incoming && sudo ufw default allow outgoing
sudo ufw allow 22/tcp && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp && sudo ufw allow 443/udp
sudo ufw enable

# 专用系统用户与目录
sudo useradd --system --home-dir /var/lib/teams --shell /usr/sbin/nologin teams
sudo install -d -o teams -g teams -m 750 /var/lib/teams /var/lib/teams/uploads
sudo install -d -o root  -g root  -m 755 /opt/teams /opt/teams/releases
sudo install -d -o root  -g teams -m 750 /etc/teams
sudo install -d -o root  -g root  -m 755 /srv/teams
sudo install -d -o root  -g root  -m 700 /var/backups/teams
```

### B.4 PostgreSQL（仅本机）

```bash
# PGDG 官方源（国内可换成 mirrors.aliyun.com/postgresql 镜像）
sudo install -d /usr/share/postgresql-common/pgdg
sudo curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc
echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt noble-pgdg main" | sudo tee /etc/apt/sources.list.d/pgdg.list
sudo apt update && sudo apt -y install postgresql-18
```

确认只监听本机（`/etc/postgresql/18/main/postgresql.conf`）：
```
listen_addresses = 'localhost'
```
`/etc/postgresql/18/main/pg_hba.conf` 只保留本机规则（默认即是）：
```
local   all   postgres                 peer
local   all   all                      peer
host    all   all   127.0.0.1/32       scram-sha-256
host    all   all   ::1/128            scram-sha-256
```

创建专用角色与库（口令在服务器上现场生成，不回显到日志）：
```bash
DB_PASSWORD="$(openssl rand -hex 24)"          # 只存在于本次 shell 和 teams.env
sudo -u postgres psql -v ON_ERROR_STOP=1 -v pw="$DB_PASSWORD" <<'SQL'
CREATE ROLE teams_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD :'pw';
CREATE DATABASE teams OWNER teams_app ENCODING 'UTF8' TEMPLATE template0;
REVOKE ALL ON DATABASE teams FROM PUBLIC;
SQL
sudo systemctl restart postgresql && sudo ss -ltnp | grep 5432   # 只应看到 127.0.0.1 / ::1
```
表结构由后端启动时自动迁移，无需手工建表。

### B.5 后端：配置文件

`/etc/teams/teams.env`：属主 `root:root`、**权限 600**（systemd 以 root 读取 `EnvironmentFile` 后再降权到 `teams` 用户运行，服务进程本身不需要读这个文件）。在服务器上现场生成：

```bash
sudo install -o root -g root -m 600 /dev/null /etc/teams/teams.env
sudo tee /etc/teams/teams.env >/dev/null <<EOF2
TEAMS_ENV=production
TEAMS_HTTP_ADDR=127.0.0.1:8090
TEAMS_PUBLIC_BASE_URL=https://teams.lovekaifa.com
TEAMS_DATABASE_URL=postgres://teams_app:${DB_PASSWORD}@127.0.0.1:5432/teams?sslmode=disable
TEAMS_SECRET_KEY=$(openssl rand -base64 48 | tr -d '\n')
TEAMS_UPLOAD_DIR=/var/lib/teams/uploads
TEAMS_CORS_ORIGINS=https://teams.lovekaifa.com
TEAMS_WEBHOOK_ALLOW_INSECURE_LOCAL=false
TEAMS_LOG_LEVEL=info
EOF2
unset DB_PASSWORD
sudo chmod 600 /etc/teams/teams.env
```

文件内容模板（仓库里只允许出现这种占位符形式）：
```
TEAMS_ENV=production
TEAMS_HTTP_ADDR=127.0.0.1:8090
TEAMS_PUBLIC_BASE_URL=https://teams.lovekaifa.com
TEAMS_DATABASE_URL=postgres://teams_app:<DB_PASSWORD>@127.0.0.1:5432/teams?sslmode=disable
TEAMS_SECRET_KEY=<TEAMS_SECRET_KEY>
TEAMS_UPLOAD_DIR=/var/lib/teams/uploads
TEAMS_CORS_ORIGINS=https://teams.lovekaifa.com
TEAMS_WEBHOOK_ALLOW_INSECURE_LOCAL=false
TEAMS_LOG_LEVEL=info
```

> `TEAMS_SECRET_KEY` 一旦丢失或更换，已保存的 webhook 密钥无法解密、已发出的附件签名失效。把它和数据库口令一起**离线**保存（密码管理器），备份时不要和数据库备份放在同一处。

### B.6 后端：二进制与 systemd

在开发机（Mac）交叉编译：
```bash
cd backend
VERSION=$(git rev-parse --short HEAD)
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags "-s -w" -o bin/teams-server-linux-amd64 ./cmd/teams-server
shasum -a 256 bin/teams-server-linux-amd64
```
（迁移 SQL 已 embed 进二进制，不需要另外上传。）

`/etc/systemd/system/teams.service`：
```ini
[Unit]
Description=TeAms backend
After=network-online.target postgresql.service
Wants=network-online.target
Requires=postgresql.service

[Service]
Type=simple
User=teams
Group=teams
EnvironmentFile=/etc/teams/teams.env
WorkingDirectory=/var/lib/teams
ExecStart=/opt/teams/current/teams-server
Restart=on-failure
RestartSec=3
TimeoutStopSec=20
LimitNOFILE=65536

# 加固
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
ReadWritePaths=/var/lib/teams
CapabilityBoundingSet=
UMask=0027

[Install]
WantedBy=multi-user.target
```
```bash
sudo systemctl daemon-reload && sudo systemctl enable teams
```

### B.7 Caddy

安装（官方 apt 源；国内慢时可从 GitHub Releases 下载 `caddy_<ver>_linux_amd64.deb` 后 `dpkg -i`）：
```bash
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt -y install caddy
```

`/etc/caddy/Caddyfile`（完整）：
```caddyfile
{
	email <ADMIN_EMAIL>
	# 后端只信任来自本机的 X-Forwarded-For；Caddy 默认会覆盖客户端伪造的该头
}

teams.lovekaifa.com {
	encode zstd gzip

	header {
		Strict-Transport-Security "max-age=31536000; includeSubDomains"
		X-Content-Type-Options "nosniff"
		Referrer-Policy "strict-origin-when-cross-origin"
		X-Frame-Options "DENY"
		-Server
	}

	# 后端 API + WebSocket（Caddy 的 reverse_proxy 自动处理 Upgrade）
	handle /api/* {
		request_body {
			max_size 110MB          # 视频上限 100MB + multipart 开销
		}
		reverse_proxy 127.0.0.1:8090 {
			flush_interval -1       # 不缓冲，WS/流式响应即时下发
			transport http {
				read_timeout 10m    # 大文件上传
				write_timeout 10m
			}
		}
	}

	# 前端静态文件（SPA：/invite/<code> 等前端路由回退到 index.html）
	handle {
		root * /srv/teams/frontend/current
		@assets path /assets/*
		header @assets Cache-Control "public, max-age=31536000, immutable"
		@html path / /index.html
		header @html Cache-Control "no-cache"
		try_files {path} /index.html
		file_server
	}

	log {
		output file /var/log/caddy/teams-access.log {
			roll_size 50MiB
			roll_keep 10
		}
		format json
	}
}

# 裸 IP 访问直接拒绝
http://123.57.134.175, https://123.57.134.175 {
	abort
}
```
```bash
sudo install -d -o caddy -g caddy /var/log/caddy
sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy
```
证书由 Caddy 自动向 Let's Encrypt 申请和续期（需 80/443 可达且**已备案**）。

### B.8 前端

前端在开发机构建（由 Tina 负责前端代码；API 使用同域相对路径 `/api/v1`，WS 用 `wss://<当前域名>/api/v1/ws`）：
```bash
cd frontend && npm ci && npm run build        # 产物 dist/
tar -C dist -czf ../teams-frontend-$(git rev-parse --short HEAD).tar.gz .
```

### B.9 发布流程

**后端**
```bash
# 开发机
VERSION=$(git rev-parse --short HEAD)
scp backend/bin/teams-server-linux-amd64 <SSH_USER>@123.57.134.175:/tmp/teams-server-$VERSION

# 服务器
VERSION=<VERSION>
sudo install -d /opt/teams/releases/$VERSION
sudo install -m 755 /tmp/teams-server-$VERSION /opt/teams/releases/$VERSION/teams-server
sudo /usr/local/bin/teams-backup.sh                 # 发布前先备份（迁移不可逆时可回滚）
sudo ln -sfn /opt/teams/releases/$VERSION /opt/teams/current
sudo systemctl restart teams
sudo journalctl -u teams -n 50 --no-pager           # 看到 "listening" 且无错误
curl -fsS http://127.0.0.1:8090/api/v1/healthz      # {"status":"ok"}
curl -fsS https://teams.lovekaifa.com/api/v1/healthz
```
回滚：`sudo ln -sfn /opt/teams/releases/<旧版本> /opt/teams/current && sudo systemctl restart teams`（若新版本包含数据库迁移，回滚二进制前要先用发布前的备份恢复数据库）。保留最近 5 个版本目录。

**前端**
```bash
# 开发机
scp teams-frontend-<VERSION>.tar.gz <SSH_USER>@123.57.134.175:/tmp/
# 服务器
sudo install -d /srv/teams/frontend/releases/<VERSION>
sudo tar -C /srv/teams/frontend/releases/<VERSION> -xzf /tmp/teams-frontend-<VERSION>.tar.gz
sudo ln -sfn /srv/teams/frontend/releases/<VERSION> /srv/teams/frontend/current
# 无需重启 Caddy；index.html no-cache，assets 带 hash 长缓存
```
前后端接口有不兼容变更时：先发后端（保持向后兼容），再发前端。

### B.10 备份

`/usr/local/bin/teams-backup.sh`（`root`，755）：
```bash
#!/usr/bin/env bash
set -euo pipefail
umask 077
TS=$(date +%Y%m%d-%H%M%S)
DIR=/var/backups/teams
KEEP_DAYS=14

# 1) 数据库：本机 peer 认证，不需要口令
sudo -u postgres pg_dump -Fc -d teams -f "$DIR/teams-db-$TS.dump"

# 2) 上传目录
tar -C /var/lib/teams -czf "$DIR/teams-uploads-$TS.tar.gz" uploads

# 3) 本地保留 14 天
find "$DIR" -type f -mtime +$KEEP_DAYS -delete

# 4) 异地：同步到阿里云 OSS（另一地域、私有 Bucket、开启版本控制），
#    凭据放在 /root/.ossutilconfig（600），使用只允许写该 Bucket 的 RAM 子账号 AccessKey
ossutil cp -r "$DIR" "oss://<BACKUP_BUCKET>/teams/" --update
```
（也可换成 `rclone` 同步到其它对象存储；OSS 侧配置生命周期规则保留 90 天。）

`/etc/systemd/system/teams-backup.service` 与 `.timer`：
```ini
# teams-backup.service
[Unit]
Description=TeAms backup
[Service]
Type=oneshot
ExecStart=/usr/local/bin/teams-backup.sh

# teams-backup.timer
[Unit]
Description=Daily TeAms backup
[Timer]
OnCalendar=*-*-* 03:30:00
RandomizedDelaySec=10m
Persistent=true
[Install]
WantedBy=timers.target
```
```bash
sudo systemctl daemon-reload && sudo systemctl enable --now teams-backup.timer
systemctl list-timers | grep teams
```

恢复演练（上线后每季度一次，在临时库上做）：
```bash
sudo -u postgres createdb -O teams_app teams_restore_test
sudo -u postgres pg_restore -d teams_restore_test --no-owner --role=teams_app /var/backups/teams/teams-db-<TS>.dump
sudo -u postgres dropdb teams_restore_test
```
正式恢复：停 `teams` → `dropdb teams && createdb -O teams_app teams` → `pg_restore` → 解压 uploads 到 `/var/lib/teams/`（属主 `teams`）→ 启动。`TEAMS_SECRET_KEY` 必须与备份时一致。

### B.11 上线检查清单

- [ ] ICP 备案已通过，域名已绑定该 ECS；计划 30 天内完成公安备案、页脚展示备案号。
- [ ] DNS `teams.lovekaifa.com A 123.57.134.175` 生效。
- [ ] 安全组：80/443 对外；22 仅运维 IP；**5432、8090 未开放**。`ufw status` 一致。
- [ ] `ss -ltnp`：8090 与 5432 只在 127.0.0.1 / ::1 上监听；对外只有 Caddy 的 80/443。
- [ ] 从外网 `curl -m 5 http://123.57.134.175:8090/` 与 `:5432` 连接失败。
- [ ] `/etc/teams/teams.env` 权限 600；`TEAMS_ENV=production`、`TEAMS_WEBHOOK_ALLOW_INSECURE_LOCAL=false`、`TEAMS_CORS_ORIGINS=https://teams.lovekaifa.com`、`TEAMS_PUBLIC_BASE_URL=https://teams.lovekaifa.com`。
- [ ] `TEAMS_SECRET_KEY`、数据库口令为现场随机生成并已离线保存；仓库中 `git grep` 不到任何真实密钥。
- [ ] `https://teams.lovekaifa.com/api/v1/healthz` 返回 ok，证书有效；`http://` 自动跳转 https。
- [ ] 浏览器：注册/登录、建 team、发消息、上传图片和视频（接近 100MB）、WebSocket 实时收到消息、刷新 `/invite/<code>` 页面不 404。
- [ ] 配置一个测试 bot，webhook 指向 Grok Bot 的 HTTPS 地址，`POST /bots/{id}/webhook/test` 返回 ok；@bot 后频道出现 `bot.run.*` 状态与回复。
- [ ] 备份 timer 已启用，手动跑一次 `teams-backup.sh`，OSS 中可见文件；做一次恢复演练。
- [ ] SSH 改为仅密钥登录，部署用的临时口令已作废/轮换。
- [ ] `unattended-upgrades` 开启安全更新；`journalctl -u teams`、Caddy 访问日志有轮转。

### B.12 运维速查

| 操作 | 命令 |
|---|---|
| 看后端日志 | `journalctl -u teams -f` |
| 重启后端 | `sudo systemctl restart teams` |
| Caddy 配置重载 | `sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy` |
| 数据库控制台 | `sudo -u postgres psql teams` |
| 磁盘占用 | `du -sh /var/lib/teams/uploads /var/backups/teams` |

---

## 备选方案（未选，保留供参考）

### 备选 A：Cloudflare Tunnel（后端留在 Mac 上）

后端继续跑在用户 Mac 上（`127.0.0.1:8090`），`cloudflared` 主动向 Cloudflare 建出站连接，Cloudflare 提供 `https://teams.<DOMAIN>`。

| 项 | 说明 |
|---|---|
| 成本 | 隧道免费；需要一个托管在 Cloudflare 的域名（约 ¥10–90/年，已有则 0） |
| 优点 | 不开路由器端口、无需公网 IP；自动 HTTPS；支持 WebSocket；自带 DDoS 防护；可叠加 Cloudflare Access 做访问控制 |
| 缺点 | Mac 必须一直开机联网，休眠即服务中断；免费版单请求体上限 100 MB（正好等于视频上限，再大需改分片上传）；国内访问 Cloudflare 速度不稳定；流量经过 Cloudflare |
| 安全 | 后端只听 127.0.0.1，隧道只转发 8090；**不要**对 Grok Bot 回调路径（`/api/v1/*`）开 Cloudflare Access 的交互登录，否则 bot 调不通——可只对前端页面加 Access，或用 Access Service Token |

用户需要做：
1. 把域名接入 Cloudflare（改 NS）。
2. `brew install cloudflared`，`cloudflared tunnel login`（浏览器授权）。
3. `cloudflared tunnel create teams`，配置 `ingress: teams.<DOMAIN> → http://127.0.0.1:8090`，`cloudflared tunnel route dns teams teams.<DOMAIN>`。
4. 设 `TEAMS_PUBLIC_BASE_URL=https://teams.<DOMAIN>`、`TEAMS_CORS_ORIGINS=https://teams.<DOMAIN>`、`TEAMS_ENV=production`。
5. 可选：`sudo cloudflared service install` 开机自启；在系统设置里关闭自动休眠。

### 备选 C：ngrok（仅临时联调）

在 Mac 上 `ngrok http 8090`，得到一个 `https://xxxx.ngrok-free.app`。

| 项 | 说明 |
|---|---|
| 成本 | 免费版可用；固定域名/去掉限制需付费（约 $8–20/月） |
| 优点 | 5 分钟可用，无需域名，适合和 Grok Bot 联调 webhook 回调 |
| 缺点 | 免费版对浏览器请求会插入警告页（API 调用需加 `ngrok-skip-browser-warning` 头，前端体验差）；免费版有连接数/流量限制；Mac 必须在线；国内访问慢；地址可能变化，每次要改 `TEAMS_PUBLIC_BASE_URL` |
| 安全 | 地址公开可猜到的风险较低但不应长期使用；用完即关 |

用户需要做：注册 ngrok 账号、`brew install ngrok`、`ngrok config add-authtoken <NGROK_TOKEN>`、运行 `ngrok http 8090`。

> 同类替代：Tailscale Funnel（免费、需 Tailscale 账号，有带宽限制）、frp（需要自己的公网服务器，相当于 B 的简化版）。

---

### 对比

| | B 阿里云 ECS + Caddy（已选） | A Cloudflare Tunnel | C ngrok |
|---|---|---|---|
| 月成本 | ECS 费用 + 域名 | ≈0（域名另计） | 0 / $8+ |
| 依赖 Mac 在线 | 否 | 是 | 是 |
| 上手时间 | 半天（另需 ICP 备案 1–3 周） | 30 分钟 | 5 分钟 |
| HTTPS / WS | 自动 / 支持 | 自动 / 支持 | 自动 / 支持 |
| 适合 | 正式长期运行 | 小团队、Mac 常开 | 备案期间临时联调 |

## 通用上线检查清单（任何方案）

- [ ] `TEAMS_SECRET_KEY`、数据库口令随机生成，只存在部署环境，不进仓库。
- [ ] `TEAMS_ENV=production`，`TEAMS_WEBHOOK_ALLOW_INSECURE_LOCAL=false`。
- [ ] `TEAMS_PUBLIC_BASE_URL`、`TEAMS_CORS_ORIGINS` 改为正式域名。
- [ ] 后端只监听 127.0.0.1。
- [ ] 数据库与上传目录定期备份并异地保存。
- [ ] Grok Bot 侧配置：webhook URL、密钥头名与值（`<SECRET_HEADER_VALUE>`）、TeAms 回调地址和 `<BOT_TOKEN>`；验签用 `<WHSEC>`。
