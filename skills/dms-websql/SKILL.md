---
name: dms-websql
version: 1.0.0
description: "阿里云 DMS WebSQL 查询：复用浏览器登录 Cookie，通过 DMS newwebsql WebSocket 直连测试/线上数据库跑只读 SQL 并打成表格。当用户粘贴一段 dms-*.alibabacloud.com 的 curl（带 Cookie/token），或要查测试环境数据库、验证测试数据、核对表/索引时使用。"
metadata:
  requires:
    bins: ["node"]   # 用 Node 内置 tls/crypto，无需 npm 依赖
---

# dms-websql — 阿里云 DMS WebSQL 查询

用 Node 内置 `tls`+`crypto` 手写最小 WebSocket 客户端，复用用户从浏览器 DevTools 抓到的 **DMS 登录 Cookie**，直连 `wss://dms-*.alibabacloud.com/ws/newwebsql/query` 在目标库跑**只读 SQL**，结果打成可读表格。零 npm 依赖。

**触发场景**：用户把一段 DMS 的 `curl 'wss://dms-....alibabacloud.com/ws/newwebsql/query' ...`（带 Cookie，可能连着 payload）发过来，说"帮我查测试环境数据"。

## 为什么这么实现（坑）

- **必须 HTTP/1.1**：DMS WS 升级走 HTTP/2 会被 302 到 `err.taobao.com`。手写 TLS 升级强制 `ALPNProtocols:['http/1.1']`。
- **必须带 Cookie**：Node 全局 `WebSocket`(undici) 不允许设 `Cookie` 头，连不上；所以手写握手。
- **不协商 permessage-deflate**：不发 `Sec-WebSocket-Extensions`，服务端就不压缩，帧解析简单可靠。
- Cookie 是完整登录态，**高度敏感**：只落盘到 `chmod 600` 临时文件，绝不写进脚本/仓库/记忆。用完可删。

## 标准流程（用户发来 curl 后）

1) **把 curl 原文存到临时文件**（scratchpad，不要进仓库），比如 `curl.txt`。

2) **解析出 Cookie/host/dbId**，Cookie 落盘到临时 cookie 文件：
```bash
node /Users/a0000/Dev/dingzhihao/skills/dms-websql/scripts/parse_curl.mjs \
  --curl-file curl.txt --out cookie.txt
# 打印 DMS_HOST=... / DMS_DBID=... / DMS_DBTYPE=... / DMS_COOKIE_FILE=...
```
`dbId` 只有在用户把 payload 一起粘进来时才能自动解析到；否则见下「怎么拿 dbId」。

3) **跑 SQL**（`--sql` 顶层按 `;` 拆多条逐条执行）：
```bash
node /Users/a0000/Dev/dingzhihao/skills/dms-websql/scripts/dms_query.mjs \
  --cookie-file cookie.txt --host <DMS_HOST> --db-id <DMS_DBID> --db-type postgresql \
  --sql "SELECT 1; SELECT now();"
```
或用现成 query pack（JSON 数组 `[{name,sql}]`）：
```bash
node .../scripts/dms_query.mjs --cookie-file cookie.txt --db-id 80166415 \
  --sql-file /Users/a0000/Dev/dingzhihao/skills/dms-websql/queries/pwa4_verify.json
```

> 也可以省掉 parse 步骤：Cookie 直接 `--cookie-file`，或 `DMS_COOKIE="$(cat cookie.txt)"` 走环境变量。

## dms_query.mjs 参数

- `--db-id N` **(必填)** 目标库 dbId
- `--host H` DMS 站点，默认 `dms-us-west-1.alibabacloud.com`（按 region 改）
- `--db-type T` 默认 `postgresql`（也可 `mysql` 等）
- `--cookie-file P` Cookie 文件；缺省读 `$DMS_COOKIE`
- `--sql "<多条;分隔>"` / `--sql-file <path>`（`.json`=[{name,sql}]，`.sql/.txt`=按 `;` 拆）/ 或 stdin
- `--no-split` 不拆，把 SQL 整体一次性发（少数需要多语句一起执行时用）
- `--json` 每条结果输出原始 JSON（给 jq/py），不打表格
- `--timeout MS` 整体超时，默认 40000

## 怎么拿 dbId / host

- **host**：curl URL 里的域名（`wss://<host>/ws/newwebsql/query`），决定 region。
- **dbId**：是 DMS 里某个库实例的数字 id。三种来源：
  1. 用户粘的 payload JSON 里 `"dbId":<n>`（parse_curl 会自动抓）；
  2. 在 DMS 网页上对某库执行任意 SQL，抓这条 WS 的 payload 看 `dbId`；
  3. 复用历史值（见下映射）。
- 返回结果的 `resultSet.executeSQL` / `orderLink...schemaDisplayName` 会带真实库名主机，可用来确认连对了库。

### 已知 dbId 映射（dev）
| dbId | 库 | 说明 |
|---|---|---|
| `80166415` | `archat` @ `pgm-2eve7e7v29eq77au...pg.rds-aliyun-america` | dev-pg-dora，pwa4/消息收益相关表都在这 |

（后续查到别的库，往这张表里补。）

## 内置 query pack

- `queries/pwa4_verify.json` — pwa4 消息收益（[[pr-1794-pwa4-message-revenue]]）全链路验证：
  flow inbox / 加钱 history+ext_id / user_balance 余额 / 死信表 / 三个一致性校验 / 四表索引核对。
  跑法：`--sql-file queries/pwa4_verify.json --db-id 80166415`。

## 注意事项

- **只读为主**：DMS 网页对结果集默认 `LIMIT 200`（脚本会在 rows 后原样带出提示）。要跑改数据/DDL 时 DMS 常需工单审批，本 skill 不处理审批流。
- **列名坑**：`user_balance` 的时间列是 `update_at`（不是 `updated_at`），且 UPDATE 不维护它——判断"是否加钱成功"看 `balance` 值本身，别看 `update_at`。
- **握手失败**多半是 **Cookie 过期**：脚本报 `握手失败`。让用户重新抓一份 curl。
- Cookie 用完即可删临时文件；本目录 `.gitignore` 已挡 `cookie*.txt`/`curl*.txt`。
