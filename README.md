# koa-agent

Koa 3 + LangGraph 的 HTTP Agent 服务骨架：把「LLM Agent（工具调用 + 多轮会话 + 流式输出）」包装成标准 HTTP API。

本项目同时是一个**学习项目** —— 源码带详细教学注释，建议按 [docs/00-代码导读.md](docs/00-代码导读.md) 的路线阅读。

## 功能

- `POST /agent/chat` —— 同步对话（自动携带多轮上下文）
- `POST /agent/chat/stream` —— SSE 逐 token 流式输出
- `GET /agent/threads/:threadId` —— 会话历史查询
- `GET /health` —— 健康检查
- 内置示例工具：`calculator`（四则运算，安全求值）/ `current_time`（IANA 时区）
- 会话持久化：SQLite（默认）或进程内存
- 模型走 OpenAI 兼容端点（OpenAI / DeepSeek / 本地 vLLM 皆可）

## 技术栈

| 组件 | 版本 | 用途 |
|---|---|---|
| Node | ≥ 22 | 运行时（原生 fetch / loadEnvFile / ESM） |
| Koa | 3.x | HTTP 服务框架 |
| zod | 4.x | 环境变量与请求体校验 |
| @langchain/langgraph | 1.x | Agent 编排（ReAct 图 + checkpointer） |
| @langchain/openai | 1.x | ChatOpenAI（支持自定义 baseURL） |
| TypeScript / tsx | 5.9 / 4.x | 类型 + 开发运行 |
| Vitest / Biome | 5.x / 2.x | 测试 / lint+format |

## 快速开始

```bash
pnpm install
cp .env.example .env         # 填入 OPENAI_API_KEY（DeepSeek 见文件内注释）

pnpm dev                     # 开发模式（tsx watch）
# 或
pnpm build && node dist/index.js   # 生产构建运行
```

冒烟（默认 127.0.0.1:3000）：

```bash
curl -s http://127.0.0.1:3000/health

curl -s -X POST http://127.0.0.1:3000/agent/chat \
  -H 'content-type: application/json' \
  -d '{"message":"帮我算 1+2*3 等于几"}'

# SSE 流式（-N 关闭 curl 缓冲）
curl -N -X POST http://127.0.0.1:3000/agent/chat/stream \
  -H 'content-type: application/json' \
  -d '{"message":"讲个 50 字内的小故事","threadId":"t_smoke_0001"}'
```

## 配置（环境变量）

| 变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `PORT` | 否 | `3000` | 监听端口 |
| `HOST` | 否 | `127.0.0.1` | 监听地址 |
| `NODE_ENV` | 否 | `development` | `development/test/production` |
| `OPENAI_API_KEY` | 是 | — | 启动即校验（fail-fast） |
| `OPENAI_BASE_URL` | 否 | `https://api.openai.com/v1` | OpenAI 兼容端点 |
| `OPENAI_MODEL` | 否 | `gpt-4o-mini` | 模型名 |
| `AGENT_SQLITE_PATH` | 否 | `./data/agent.sqlite` | SQLite 路径；`:memory:` 用内存 |

> `.env` 仅存本地且被 gitignore，仓库只提交 `.env.example`；测试不读真实 env、不访问外网。

## API 一览

| 接口 | 请求 | 响应 |
|---|---|---|
| `POST /agent/chat` | `{message, threadId?}` | `{threadId, reply}` |
| `POST /agent/chat/stream` | 同上 | SSE：`message.delta` / `message.done` / `error` |
| `GET /agent/threads/:threadId` | — | `{threadId, messages:[{role,content}]}` |
| `GET /health` | — | `{status, uptime, version}` |

错误统一信封：`{"error":{"code","message","details?"}}`（422 校验失败 / 404 未知 / 502 Agent 失败 / 500 内部）。

## 项目结构

```
src/
├── index.ts           # 入口：加载 .env、启动、优雅退出
├── server.ts          # startServer（监听/端口/关闭，prod 与测试共用）
├── app.ts             # createApp：中间件与路由装配
├── config.ts          # 环境变量校验（zod）
├── errors.ts          # HttpError（携带 HTTP 状态与业务码）
├── sse.ts             # SSE 帧写出工具
├── version.ts         # 版本常量
├── middleware/        # error（统一错误信封）/ logger（JSON 行日志）
├── routes/            # health / agent（chat、stream、threads）
├── agent/             # model / tools / graph / streaming / checkpoint
└── testing/           # FakeChatModel 等测试基建（不进构建产物）
docs/                  # 00 代码导读 + 01~04 项目四件套
```

## 测试与质量

```bash
pnpm test        # 79 tests / 12 files（全离线：零真实 Key、零外网）
pnpm lint        # biome check
pnpm typecheck   # tsc --noEmit
pnpm build       # tsc → dist/
```

测试策略：单元（config / tools / graph / streaming）+ 真实 HTTP 集成（随机端口 + `fetch`，含 SSE 帧解析）；模型用 `FakeChatModel` 脚本化替代。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/00-代码导读.md](docs/00-代码导读.md) | **如何读懂本项目（建议从这里开始）** |
| [docs/01-需求文档.md](docs/01-需求文档.md) | 需求与验收标准 |
| [docs/02-技术文档.md](docs/02-技术文档.md) | 技术选型 / API / 架构 / 实测结论 |
| [docs/03-任务拆解.md](docs/03-任务拆解.md) | Phase → Task 拆解 |
| [docs/04-任务进度.md](docs/04-任务进度.md) | 执行记录与决策（ADR） |
