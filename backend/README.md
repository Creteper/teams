# TeAms backend

Go 1.26 + PostgreSQL 18。设计见 `../docs/architecture.md`，接口见 `../docs/api.md`。

- 默认监听 `127.0.0.1:8090`（3000 已被其他服务占用，勿用）。
- 配置走环境变量，本地可放 `backend/.env`（已忽略，模板见 `.env.example`）。
- 第一阶段只有文档，代码在下一阶段实现。
