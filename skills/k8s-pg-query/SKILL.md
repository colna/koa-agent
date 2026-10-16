---
name: k8s-pg-query
version: 1.0.0
description: "k8s 直连测试环境 PG 查询：通过 kubectl 进 dora-dev pod，用 pod 自带 jshell + vertx-pg-client 连 archat 等库跑只读 SQL。当用户要用 k8s/kubectl 连测试环境数据库、验证应用实际连的实例、或 DMS 上没配的库时使用。日常查数据优先用 dms-websql skill。"
metadata:
  requires:
    bins: ["kubectl", "python3", "bash"]   # kubectl 已配 context；pod 侧只用 jshell(内置)
---

# k8s-pg-query — 通过 k8s 直连测试环境 PG 查询

`kubectl exec` 进 dora-dev 的 pod，用 pod 自带的 `jshell` + 应用 `vertx-pg-client 4.5.8`（`/app/libs/*`）直连 archat 库跑**只读 SQL**。连接串从 pod 里 nacos 本地快照（明文）读。脚本在 Mac 侧编排全过程，只用 `kubectl`。

**与 [[dms-websql-skill]] 的分工**：日常查数据优先 DMS（不碰明文密码、不进生产 pod、有审计）。本 skill 用于 **DMS 上没配的库**，或要确认**应用运行时到底连哪个实例/连接串**这类排查（就是它发现了 dev 有两个 archat 实例、DMS 与应用连的是同一个 `pgm-2eve7e7v29eq77au`）。

## 用法

```bash
SK=/Users/a0000/Dev/dingzhihao/skills/k8s-pg-query/scripts/k8s_pg_query.sh

# 单条 / 多条(顶层按 ; 拆)
$SK --sql "SELECT count(*) FROM pwa_balance_msg_flow;"
$SK --sql "SELECT 1; SELECT now();"

# 用现成 pack
$SK --sql-file /Users/a0000/Dev/dingzhihao/skills/k8s-pg-query/queries/pwa4_verify.sql

# 查 monitor 库、指定 pod、看连到哪
$SK --ds monitor --sql "SELECT now();"
$SK --show-conn --pod offline-task-service-xxx --sql "..."
```

## 参数

- `--sql "<多条;分隔>"` / `--sql-file <path>`（`.sql/.txt`=按 `;` 拆；`.json`=`[{"name","sql"}]`）
- `--ds pgCfg|monitor` 连接串来源，默认 `pgCfg`（archat 主库）；`monitor`=db_monitor 库
- `--pod NAME` 目标 pod；缺省自动选 Running 的 `offline-task-service`
- `--ns NS` 默认 `dora-dev`
- `--tenant T` nacos tenant，默认 `dora-dev-k8s`（**别改**，见下）
- `--timeout SEC` 单条等待秒，默认 15
- `--show-conn` 额外打印连到的 `user@host:port/db`（不打印密码）

## 关键坑（都已在脚本里规避）

1. **nacos 有两份 global_db_config，指向不同 archat 实例**——必须 pin tenant `dora-dev-k8s`：
   - `dora-dev-k8s`（正确）→ `pgm-2eve7e7v29eq77au`，pwa4 新表(`pwa_balance_msg_flow`/`_dead`)在这，= DMS dbId 80166415 同一实例；
   - `b6499ade-...`（错的）→ `pgm-2evut9jhd13kh321`，787 张老表但缺 pwa4 新表，查会报 `relation ... does not exist (42P01)`。
   脚本用 `fixed-dora-dev-k8s-mse-*/snapshot-tenant/dora-dev-k8s/...` 精确路径，不用通配 glob。
2. **pod 精简**：只有 bash/java/jshell，无 psql/jq/python/curl/redis-cli。所以 JSON 解析、SQL 拆分都放 Mac 侧 python 做，只把生成好的 `.jsh` 管道喂进 pod 的 jshell。
3. **jshell 是异步**：vertx 查询要 `CountDownLatch` + `latch.await()` 阻塞等结果，否则脚本先退出拿不到行。
4. **log4j/agent 噪音**：pod 启动打一堆 log 到 stderr，还有 `Script support is not enabled` 等 ERROR（无害）。脚本 `2>/dev/null` + 只 grep `COLS/NROWS/ROW/ERROR/#####` 行。
5. **SQL/密码转义**：全走 base64 塞进 jsh（`Base64.getDecoder().decode`），杜绝引号/分号/特殊字符把 Java 字符串搞坏；密码从不落进命令行。

## 输出格式

每条语句一段：`##### [i/n] 名字 #####` → `COLS a | b | c` → `NROWS n` → 每行 `ROW a=..  b=..`。任意列通用（用 `rs.columnsNames()` + `row.getValue(i)`）。

## 内置 pack

- `queries/pwa4_verify.sql` — pwa4 消息收益全链路验证（flow / history+ext_id / user_balance / 死信 / 三个一致性校验）。已验证结果与 DMS 一致。
  坑：`user_balance` 时间列是 `update_at`（非 updated_at）且 UPDATE 不维护，判加钱成功看 `balance` 值本身。

## 排查提示

- 报连不上/超时：确认 `kubectl config current-context` 指向 dev ACK、pod 是 Running。
- 报 `relation does not exist`：多半连错实例，确认 `--tenant dora-dev-k8s` 且没被别的 tenant 快照干扰。
- 只读为宜；改数据/DDL 走正规发布流程，别在这跑。
