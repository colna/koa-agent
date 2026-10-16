---
name: sls-logs
version: 1.0.0
description: "阿里云 SLS 日志查询：从阿里云日志服务(SLS/Log Service)读取线上/测试环境日志。当用户要查 SLS 日志、排查线上问题、按服务/关键词/时间检索日志、统计日志、或提到 aliyuncs.com log project/logstore 时使用。"
metadata:
  requires:
    bins: ["python3"]
    pip: ["aliyun-log-python-sdk"]
---

# sls-logs — 阿里云 SLS 日志查询

用官方 `aliyun-log-python-sdk` 调 GetLogs，自动签名 + 自动分页。凭证从 `~/.sls_creds` 读，**不写进本 skill**。

参考文档：https://www.alibabacloud.com/help/zh/sls/developer-reference/get-logs

## 一次性配置

1) 安装 SDK（已装可跳过）：
```bash
python3 -m pip install aliyun-log-python-sdk
```

2) 写凭证文件 `~/.sls_creds`（`chmod 600`，**勿提交/分享**）：
```bash
umask 077 && cat > ~/.sls_creds <<'EOF'
export SLS_ENDPOINT=us-west-1.log.aliyuncs.com
export SLS_PROJECT=dev-presence-service-log
export SLS_LOGSTORE=dora-dev-stdout
export SLS_AK_ID=<AccessKey ID>
export SLS_AK_SECRET=<AccessKey Secret>
# export SLS_STS_TOKEN=<可选 STS token>
EOF
```
> 安全：优先用只授 `log:GetLogStoreLogs` 且限定到该 logstore 的**只读 RAM 子账号**，或 STS 临时凭证。别用主账号 AK。

## 用法

每次查询前先 `source ~/.sls_creds`：
```bash
source ~/.sls_creds && python3 skills/sls-logs/scripts/sls_query.py <参数>
```

参数：
- `--query '<SLS语句>'`  查询/分析语句（默认 `*`）
- `--service <名字>`     快捷按服务过滤（自动拼 `__tag__:_service_name_ : <名字> and (<query>)`）
- `--minutes N`          最近 N 分钟；或 `--from '<UTC>' --to '<UTC>'`（格式 `YYYY-MM-DD HH:MM:SS`，**UTC**）
- `--limit N`            最多行数，自动分页（默认 100）
- `--reverse`            最新在前
- `--raw`                输出原始 JSON（每行一条，给 jq/python 下游处理）
- `--no-strip`           保留 ANSI 颜色码（默认去除）

## SLS 查询语法要点

- **方括号短语必须加双引号**：`"[AI_CHAT_SERVICE] origin timMessage"`（`[` `]` 是分词符，裸写查不准）
- 多词空格 = AND；或用大写 `OR`；排除用 `NOT`
- 字段查询：`字段名 : 值`
- 分析（SQL）：`<检索条件> | SELECT ...`，字段名带特殊字符要加双引号，如 `select "__tag__:_service_name_" as svc`
- 时间在参数里给，不写进 query

## 常用字段（因 logstore 而异，先跑一条 `--raw` 看实际字段）

以 `dev-presence-service-log / dora-dev-stdout` 为例（多服务混存）：
- 正文 = `content`
- 级别 = `severity`（INFO/ERROR）
- 服务名 = `__tag__:_service_name_`（如 `ai-chat-service` / `aichat-v2` / `gateway-ws-service`…）
- 其它 tag：`__tag__:_pod_name_`、`__tag__:_namespace_`、`__tag__:_container_name_`
- 环境 = `_environment_`

## 示例

```bash
# 某服务 + 关键词，最近 1 小时
source ~/.sls_creds && python3 skills/sls-logs/scripts/sls_query.py \
  --service ai-chat-service --query '"[AI_CHAT_SERVICE] origin timMessage"' --minutes 60

# 指定 UTC 时间窗，查错误
... --query '"Failed to update chat message vector"' --from '2026-07-03 02:00:00' --to '2026-07-03 03:00:00' --limit 200

# 各服务日志量统计（SQL）
... --query '* | select "__tag__:_service_name_" as svc, count(*) c group by svc order by c desc' --minutes 120

# 按某 id/msgKey 精确追踪一条链路
... --query '"3063315071_2320521194_1783046358"' --minutes 120 --limit 50

# 原始 JSON 交给 jq
... --service aichat-v2 --query '"error"' --minutes 30 --raw | jq -r '.content'
```

## 排查提示

- **搜不到别急着下结论**：同一条业务链路，不同日志可能用不同标识键（如主链路用 `chatID`/`msgKey`，另一些日志用 `sessionKey`），出站日志字符串也可能不是你以为的那个。先用一个已知的稳定 id（msgKey/traceId）把整条链路拉出来，再按需过滤。
- **区分同名服务的版本**：v1、v2 可能在同一 logstore、日志字符串相同，只能靠 `__tag__:_service_name_` 区分。
- 时间窗查不到时，确认 `--from/--to` 是 **UTC**。
