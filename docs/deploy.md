# TeAms 公网部署方案（仅方案，未实施）

> 本阶段**不做任何部署、不开公网端口、不建隧道**。以下供用户选择后再执行。

## 为什么需要公网

- 出站 webhook（TeAms → Grok Bot）只需要本机能上网，**不需要**公网地址。
- 但 Grok Bot 处理完要**回调** TeAms API（`POST /api/v1/channels/{id}/messages`），并下载 webhook 里的附件 URL，所以 TeAms 后端必须有一个 Grok Bot 能访问到的 HTTPS 地址（`TEAMS_PUBLIC_BASE_URL`）。
- 团队成员不在同一局域网时，前端也需要公网访问。

推荐形态：前端构建成静态文件，与后端同域（`https://<DOMAIN>/` 前端，`https://<DOMAIN>/api/v1/*` 后端，WS 同域 `wss://<DOMAIN>/api/v1/ws`），免去 CORS。

---

## 方案 A：Cloudflare Tunnel（推荐先用）

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
4. 设 `TEAMS_PUBLIC_BASE_URL=https://teams.<DOMAIN>`、`TEAMS_CORS_ORIGINS=https://teams.<DOMAIN>`。
5. 可选：`sudo cloudflared service install` 开机自启；在系统设置里关闭自动休眠。

## 方案 B：云服务器（VPS）+ Caddy 反向代理 HTTPS

把后端（单个 Go 二进制）、PostgreSQL、上传目录部署到云服务器，Caddy 自动申请 Let's Encrypt 证书并反代。

| 项 | 说明 |
|---|---|
| 成本 | 香港/海外 1C2G 约 ¥30–80/月（腾讯云/阿里云轻量、Vultr、Hetzner 等）+ 域名；国内大陆机器更便宜但需要备案 |
| 优点 | 7×24 在线，不依赖 Mac；性能、带宽、上传大小可控；最接近正式生产 |
| 缺点 | 要运维（系统更新、备份、监控）；**大陆服务器用 80/443 绑定域名必须 ICP 备案**（数周），香港/海外免备案但国内访问延迟稍高；数据要从本机迁移 |
| 安全 | 防火墙只开 22/80/443；SSH 只用密钥、禁 root 密码登录；PostgreSQL 只听 127.0.0.1；后端只听 127.0.0.1:8090；密钥放 systemd `EnvironmentFile`（权限 600），不进仓库；每日 `pg_dump` + 上传目录备份到异地 |

用户需要做：
1. 购买 VPS（选地区）和域名，域名 A 记录指向 VPS IP。
2. 给我们 SSH 访问方式（或自己按文档执行）。
3. 服务器装 PostgreSQL 18、Caddy；上传后端二进制，systemd 托管。
4. Caddyfile 示例：
   ```
   teams.<DOMAIN> {
       encode gzip
       handle /api/* { reverse_proxy 127.0.0.1:8090 }
       handle { root * /srv/teams/frontend; try_files {path} /index.html; file_server }
       request_body { max_size 110MB }
   }
   ```
5. 设置 `TEAMS_PUBLIC_BASE_URL=https://teams.<DOMAIN>`。

## 方案 C：ngrok（仅临时联调）

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

## 对比与建议

| | A Cloudflare Tunnel | B VPS + Caddy | C ngrok |
|---|---|---|---|
| 月成本 | ≈0（域名另计） | ¥30–80 + 域名 | 0 / $8+ |
| 依赖 Mac 在线 | 是 | 否 | 是 |
| 上手时间 | 30 分钟 | 半天（大陆需备案数周） | 5 分钟 |
| HTTPS / WS | 自动 / 支持 | 自动 / 支持 | 自动 / 支持 |
| 适合 | 小团队日常使用 | 正式长期运行 | 临时联调 |

建议：**联调阶段用 C 或 A，日常小团队用 A，确定长期使用后迁到 B。**

## 通用上线检查清单

- [ ] `TEAMS_SECRET_KEY`、数据库口令随机生成，只存在部署环境，不进仓库。
- [ ] `TEAMS_WEBHOOK_ALLOW_PRIVATE=false`。
- [ ] `TEAMS_PUBLIC_BASE_URL`、`TEAMS_CORS_ORIGINS` 改为正式域名。
- [ ] 后端只监听 127.0.0.1。
- [ ] 数据库与上传目录定期备份。
- [ ] Grok Bot 侧配置：webhook URL（Grok Bot 定时任务的 webhook 触发地址）、密钥头名与值、TeAms 回调地址和 `<BOT_TOKEN>`。
