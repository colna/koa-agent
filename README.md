# koa-agent

Koa 3 + LangGraph 的 HTTP Agent 服务 + Next.js 聊天界面（**pnpm monorepo**）。

服务把「LLM Agent（工具调用 + 多轮会话 + 流式输出）」包装成标准 HTTP API；web 提供逐 token 的流式聊天可视化。本项目同时是一个**学习项目** —— 源码带详细教学注释，建议按 [docs/00-代码导读.md](docs/00-代码导读.md) 的路线阅读。

## 仓库结构

```
apps/
├── server/   # Koa 3 + LangGraph Agent 服务（API / SSE / SQLite 会话）
└── web/      # Next.js 16 聊天界面（流式渲染 / 多轮会话 / 历史回读）
docs/         # 00 代码导读 + 01~04 项目四件套
```

## 功能

**server**（apps/server）

- `POST /agent/chat` —— 同步对话（多轮上下文）
- `POST /agent/chat/stream` —— SSE 逐 token 流式
- `GET /agent/threads/:threadId` —— 会话历史
- `GET /health` —— 健康检查
- 示例工具：`calculator`（安全求值）/ `current_time`（IANA 时区）
- SP 运维工具（Agent 可调用，经 minerva BFF）：发信号（双步确认）/ 脚本错误分析与报表 / CSV 导出 / 在线分析
- SQLite 会话持久化；模型走 OpenAI 兼容端点（OpenAI / DeepSeek / 本地 vLLM）

**web**（apps/web）

- 聊天界面：逐 token 流式显示、停止生成、新会话
- 刷新恢复：localStorage 记住 threadId + 历史回读接口
- server 健康指示（绿/红点）、错误气泡提示

## 快速开始

```bash
pnpm install

# 1) 启动 server（默认 127.0.0.1:3000）
cp apps/server/.env.example apps/server/.env   # 填入 OPENAI_API_KEY（DeepSeek 见文件内注释）
pnpm dev:server

# 2) 启动 web（默认 http://127.0.0.1:3001）
pnpm dev:web
```

浏览器打开 http://127.0.0.1:3001 输入问题即可。浏览器**直连** server（默认 3000），跨域由 server 的 CORS 中间件放行；web 地址可通过 `NEXT_PUBLIC_SERVER_URL` 覆盖。

## 常用命令（仓库根目录）

| 命令 | 说明 |
|---|---|
| `pnpm dev:server` / `pnpm dev:web` | 分别启动 server / web 开发模式 |
| `pnpm test` | 递归跑全部测试（server 83 + web 8，全离线，无需 key） |
| `pnpm lint` / `pnpm typecheck` / `pnpm build` | 全仓 lint / 类型检查 / 构建 |

## 配置

- **server**：`apps/server/.env`（见 `apps/server/.env.example`）—— `OPENAI_API_KEY`（必填）/ `OPENAI_BASE_URL` / `OPENAI_MODEL` / `PORT` / `HOST` / `CORS_ORIGIN` / `AGENT_SQLITE_PATH`
- **web**：`NEXT_PUBLIC_SERVER_URL`（默认 `http://127.0.0.1:3000`；本地开发无需配置）

> `.env` 仅存本地且被 gitignore，仓库只提交 `.env.example`；测试零真实 Key、零外网。

## SP Agent（social-proxy 运维）

Agent 内置 6 个 SP 工具（直连 minerva BFF）：`sp_send_signal`（**双步确认**：先复述、用户同意后再发）、`sp_query_script_errors`（聚合统计）、`sp_build_error_report`（Markdown 报表）、`sp_export_script_errors_csv`（下载链接走 `GET /sp/reports/:name`）、`sp_online_overview`、`sp_dashboard_query`。

配置（`apps/server/.env`）：

| 变量 | 说明 |
|---|---|
| `SP_ADMIN_BASE_URL` | BFF 地址：dev `https://admin-api-dev.sitin.ai` / prod `https://admin-api-prod.sitin.ai` |
| `SP_ADMIN_TOKEN` | minerva **sessionToken**（获取：登录 admin 后台 → 开发者工具 Console 执行 `localStorage.sessionToken`，或任一请求的 `Authorization` 头去掉 `Bearer `） |
| `SP_REPORT_DIR` | 报表 / CSV 落盘目录（默认 `./data/reports`） |

> token 权限等同你的账号、且会过期——仅存本地 `.env`，过期后在浏览器重新登录并更新即可。
> `scripts/make-sp-token.mjs` 是自签方案（需 JWT_SECRET 与所连环境一致）；**对部署的 dev/prod 不适用**（部署 secret 与仓库文件不一致，已实测），保留供本地启动 minerva 的场景。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/00-代码导读.md](docs/00-代码导读.md) | **如何读懂本项目（建议从这里开始）** |
| [docs/01-需求文档.md](docs/01-需求文档.md) | 需求与验收标准 |
| [docs/02-技术文档.md](docs/02-技术文档.md) | 技术选型 / API / 架构 / monorepo 与 web / 实测结论 |
| [docs/03-任务拆解.md](docs/03-任务拆解.md) | Phase → Task 拆解 |
| [docs/04-任务进度.md](docs/04-任务进度.md) | 执行记录与决策（ADR） |
