---
name: sp_data_report
description: 根据一条 DMS websql 的 ws curl，自动跑 SP 业务 SQL 模板并生成「最近一周」的 HTML 数据报表（在线时长/在线人数/ce 漏斗/signal·todo·behavior 类型与失败分布）。用户只需给出 curl，无需其他输入。
---

# sp_data_report — SP 周报自动生成

把「连 DMS websql WebSocket → 跑一批固定 SQL → 生成 ECharts HTML 报表」整套流程固化下来。
**触发条件**：用户给出一条阿里云 DMS（`dms-*.alibabacloud.com/ws/newwebsql/query`）的 `curl` 命令，
要「更新/生成最近一周的数据报表」。只需 curl，时间窗口与 SQL 全部内置。

## 前置
- Node ≥ 22（用内置全局 `WebSocket`，无需安装任何依赖）。本机当前满足。
- curl 必须带 **Cookie**（`-b '...'` 或 `-H 'Cookie: ...'`）——这是 DMS 的登录态，会过期，过期需用户重抓。

## 一步到位（推荐）
拿到用户的 curl 后：

1. 把整条 curl 原样存成文件，例如 `curl.txt`（避免 shell 转义问题，直接写文件）。
2. 运行：
   ```bash
   node <skill>/lib/generate.js --curl curl.txt --out sp_report.html
   ```
3. 把产出的 `sp_report.html` 复制到**当前会话的 MetaBot 输出目录**（环境里的
   `metabot-outputs-*/<chat_id>/`），文件会自动发给用户。
4. 给用户一句话总结：统计区间 + 几个关键 KPI（人均在线时长、日均在线人数、ce 男女比、平均收发消息数）。

`generate.js` 会：解析 curl 里的 ws url + cookie → 自动算时间窗口 → 顺序跑 18 条 SQL（每条一个独立 ws 连接）→ 写出 `sp_report_data.json`（原始结果）和自包含 HTML。

### 时间窗口（自动，无需用户给）
- `--week-start`：默认 **今天 − 7 天**（统计区间起点，SQL 里 `… >= weekStart`）
- `--end-date`：默认 **今天**（仅用于标题；注意当天数据未满全天）
- `--dist-day`：默认 **昨天**（在线时长分布饼图取的代表单日）

需要别的区间时显式传：`--week-start 2026-06-15 --end-date 2026-06-22 --dist-day 2026-06-21`。

### 其他参数（一般用默认）
- `--ws`：默认 `wss://dms-us-west-1.alibabacloud.com/ws/newwebsql/query`（curl 里若有会覆盖）
- `--db-id`：默认 `80163632`　`--db-type`：默认 `postgresql`（这套库的固定值）
- `--cookie-file`：不想用 curl 时，直接给 cookie 文本文件
- `--out` / `--data-out`：HTML 与原始 JSON 输出路径

## 目录结构
```
sp_data_report/
  SKILL.md
  lib/
    generate.js        # 编排入口：curl→解析→跑数→出 HTML
    parse_curl.js      # 从 curl 提取 {url, cookie}
    queries.js         # 18 条 SQL 模板（按 weekStart/distDay 参数化）
    run_reports.js     # 通过 ws 顺序执行查询，返回 {id:{columns,rows}} 结果
    generate_html.js   # 结果 → 自包含 ECharts HTML
    echarts.min.js     # 内联用，离线可看（~1MB）
```

## SQL 模板清单（`lib/queries.js`，共 18 条）
每条带 `kind` 决定渲染方式：`scalar`=KPI 数字，`line`=折线，`pie`=饼图，`pie_grouped`=按列拆多饼，`table`=表格。

| id | 报表 | 表 | 时间条件 |
|----|------|----|---------|
| avg_daily_per_user_min | 人均日均在线时长(KPI) | sp_v3_online_session | `DATE(connected_at) >= weekStart` |
| online_minutes_daily | 人均在线时长(折线) | sp_v3_online_session | 同上 |
| avg_daily_online_users | 日均在线人数(KPI) | sp_v3_online_session | 同上 |
| online_users_daily | 日均在线人数(折线) | sp_v3_online_session | 同上 |
| duration_dist | 在线时长分布(饼) | sp_v3_online_session | `DATE(connected_at) = distDay` |
| daily_ce | 每日 ce 次数(折线) | user_ins_exchange_order | `DATE(create_at) >= weekStart` |
| ce_gender | ce 男女主动比例(表) | user_ins_exchange_order | 同上 |
| ce_signal_followback_dm | ce 信号+回关/打招呼成败(表) | sp_v3_signal⋈sp_v3_todo | `DATE(s.created_at) >= weekStart` |
| fail_reason_followback_dm | 回关/打招呼失败原因(双饼) | sp_v3_signal⋈sp_v3_todo | `s.created_at >= weekStart` |
| chat_daily | sp 后聊天数据(表) | social_proxy_ig_message_logs | `created_at >= weekStart` |
| avg_msg_per_pair | 平均每对收/发(表) | social_proxy_ig_message_logs | 同上 |
| send_dist | 发送量 creator 分布(饼) | social_proxy_ig_message_logs | 同上 |
| signal_type / signal_fail | signal 类型/失败(饼) | sp_v3_signal | `created_at >= weekStart` |
| todo_type / todo_fail | todo 类型/失败(饼) | sp_v3_todo | `created_at >= weekStart` |
| behavior_type / behavior_fail | behavior 类型/失败(饼) | sp_v3_behavior_log | `created_at >= weekStart` |

> 改报表口径只动 `queries.js`；改版式只动 `generate_html.js`。两者解耦。

## 报表版式（`generate_html.js`）
- 顶部 4 个 KPI 卡（人均在线时长 / 日均在线人数 / 平均每对收·发消息）
- 三大板块：① PWA 在线数据 ② 业务漏斗数据 ③ 服务运行数据
- 失败原因饼图自动保留占比 Top9、其余并入「其他」；超长原因名截断到 ~40 字
- ECharts 内联，**离线 `file://` 可直接打开**

## 重要坑（已内置处理，勿删）
1. **DB 文本字段含注入脚本**：`error`/失败原因里可能有 IG 注入的 `data:text/javascript;base64,…`、`</script>`、`<` 等。
   - 表格单元格一律 HTML 转义（`esc`）。
   - 内联 JSON 用 `jsonInline` 把 `<` `>` `U+2028` `U+2029` 转成 `\uXXXX`，否则 `<script>` 会被提前闭合、整页 JS 崩。
2. **结果行在 `resultSet.result`**，不是 `rows`；列名取 `columns[].realName`，值按 `columns[].field`（C_1…）取。
3. **默认最多 200 行**：本套都是聚合查询，行数远小于 200，无需分页。
4. **ws 协议**：发 `{type:"execute",data:{sql,dbId,dbType,...},token:""}`，依次收 `execResList`→`execResQueryId`→（含 `resultSet` 的）`execResult`，拿到 `resultSet` 即完成。

## Cookie 过期怎么办
报错/超时多半是 cookie 失效。让用户在浏览器 DevTools 重新复制 DMS 页面的请求 curl（含最新 Cookie），再跑一次即可。
