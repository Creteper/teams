# 用阿里云函数计算转发 Chrome 离线推送

TeAms 在北京 ECS 上生成 VAPID 签名并加密消息，香港函数将密文投递到 Google FCM。已有 Chrome 订阅继续使用原来的 VAPID 公钥。函数只需要独立的中转令牌。打开页面时的 WebSocket 提醒和其他厂商的 Web Push 继续使用原通道。

## 1. 创建 Web 函数

在函数计算 FC 3.0 控制台选择 **中国香港（cn-hongkong）**，创建 **Web 函数**。选择代码包部署，上传本次准备的 `backend/dist/teams-push-relay-fc.zip`，保留 ZIP 根目录中可执行的 `bootstrap`。

| 配置项 | 填写值 |
|---|---|
| 函数名 | `teams-push-relay` |
| 运行环境 | Linux 自定义运行时，例如 Custom Debian 12 或 Custom Debian 10 |
| 架构 | x86_64 / AMD64 |
| 启动命令 | `/code/bootstrap` |
| 监听端口 | `9000` |
| 执行超时 | 30 秒 |
| 规格 | 可从 0.25 vCPU、256 MB 开始 |
| 网络 | 开启「允许访问公网」；使用默认网络即可 |
| 环境变量 | `TEAMS_PUSH_RELAY_TOKEN`，填入下面复制的 64 位字符串 |

本次配置已在 Mac 的 `backend/config.local.push-relay-token` 保存独立随机令牌。打开终端执行：

```sh
cd /Users/creteper/projects/teams
tr -d '\n' < backend/config.local.push-relay-token | pbcopy
```

将剪贴板粘贴到函数环境变量的「值」中，然后部署代码和配置。该本地文件仅当前用户可读，Git 已忽略。需要在其他环境重新生成时用 `openssl rand -hex 32`，并同步更新两端的令牌。

## 2. 配置 HTTP 触发器

若控制台已自动创建 HTTP 触发器，直接编辑该触发器。启用公网 HTTPS 访问，允许 **POST**，认证方式选 **无需认证 / 匿名**。应用层会在每次请求上校验中转令牌。保留默认的原始请求路径转发。函数只接受固定的 FCM 主机和订阅路径。

复制触发器详情中的 **公网 HTTPS URL**。在 Mac 的项目根目录验证（把第一行替换为实际触发器公网地址）：

```sh
relay_base='https://你的函数公网域名'
printf 'X-Teams-Relay-Token: %s\n' "$(cat backend/config.local.push-relay-token)" |
  curl --fail-with-body --max-time 30 -X POST -H @- "${relay_base%/}/check-fcm"
```

预期返回类似 `{"reachable":true,"fcm_http_status":404}`。内层 404 是 Google 根路径对 HEAD 的响应，证明函数已经连通 Google。外层 401 表示请求没有通过认证，请核对环境变量值、触发器认证和当前部署版本。外层 502 时检查函数公网出网及冷启动日志。务必保留触发器返回的 HTTPS 域名，不要把中转令牌、VAPID 私钥或完整订阅地址发到聊天中。

## 3. 接入北京 TeAms 后端

后端须部署包含 `internal/pushrelay` 的新版二进制。在 `/etc/teams/teams.env` 设置（保留已有 VAPID 配置）：

```dotenv
TEAMS_PUSH_RELAY_URL=https://你的函数公网域名/push
TEAMS_PUSH_RELAY_TOKEN=与香港函数相同的64位字符串
```

重启 `teams.service` 并检查 `/api/v1/healthz`。先在北京 ECS 用相同方式请求 `/check-fcm`，再用另一个账号从频道成员列表 @ 测试用户。让测试用户保持 Chrome 运行、关闭所有 TeAms 标签页，并确认系统通知已允许。FCM 的 2xx 表示已接收，最终验收以设备弹出通知为准。Chrome 设备自身也需要能连接 Google 推送服务。

停用中转时从后端配置移除两个 `TEAMS_PUSH_RELAY_*` 变量并重启服务，即恢复原有直连投递。

## 从源码重新打包

在仓库的 `backend` 目录执行：

```sh
mkdir -p dist
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o dist/bootstrap ./cmd/teams-push-relay
(cd dist && zip -X -j teams-push-relay-fc.zip bootstrap)
```

入口为 `cmd/teams-push-relay/main.go`，转发代码为 `internal/pushrelay/relay.go`。
