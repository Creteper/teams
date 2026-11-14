# TeAms backend

Go 1.26 + PostgreSQL 18。设计见 `../docs/architecture.md`，接口见 `../docs/api.md`，部署见 `../docs/deploy.md`。

- 默认监听 `127.0.0.1:8090`（3000 已被其他服务占用，勿用）；前端开发端口 5190。
- 配置走环境变量，本地放 `backend/.env`（已忽略，权限 600，模板见 `.env.example`，只有占位符）。
- 启动时自动执行 `migrations/` 下的 SQL 迁移。

```bash
cd backend
go vet ./... && go build ./...
go test -race ./...          # 集成测试需要 TEAMS_TEST_DATABASE_URL（从 .env 读取），会重建 teams_test 库的 schema
go run ./cmd/teams-server    # 读取 .env，监听 127.0.0.1:8090
```

本地联调 webhook 接收器（http://127.0.0.1:xxxx）时，在 `.env` 中设 `TEAMS_ENV=dev` 和 `TEAMS_WEBHOOK_ALLOW_INSECURE_LOCAL=true`，用完改回 `false`。生产必须为 `false`。
