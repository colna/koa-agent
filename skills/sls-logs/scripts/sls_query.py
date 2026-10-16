#!/usr/bin/env python3
"""
读阿里云 SLS 日志（GetLogs / GetLogStoreLogs）。

凭证与连接信息从环境变量读取（建议放在 ~/.sls_creds，chmod 600，用前先 source）：
  SLS_ENDPOINT   e.g. us-west-1.log.aliyuncs.com / cn-hangzhou.log.aliyuncs.com
  SLS_PROJECT    project 名
  SLS_LOGSTORE   logstore 名
  SLS_AK_ID      AccessKey ID（建议只读 RAM 子账号）
  SLS_AK_SECRET  AccessKey Secret
  SLS_STS_TOKEN  (可选) STS 临时凭证 token

依赖：python3 -m pip install aliyun-log-python-sdk

时间：--from/--to 按 **UTC** 解析（与 SLS 日志时间一致，避免本地时区错位）。
      --minutes 用系统当前 epoch，不受时区影响。

示例：
  # 最近 60 分钟、某服务、含关键词
  python3 sls_query.py --service ai-chat-service --query '"[AI_CHAT_SERVICE] origin timMessage"' --minutes 60

  # 指定 UTC 时间窗
  python3 sls_query.py --query '"Failed to update chat message vector"' \
      --from '2026-07-03 02:00:00' --to '2026-07-03 03:00:00' --limit 200

  # SQL 分析（管道后接标准 SQL）
  python3 sls_query.py --query '* | select "__tag__:_service_name_" as svc, count(*) c group by svc order by c desc' --minutes 120

  # 原始 JSON 输出（给下游 jq/python 处理）
  python3 sls_query.py --service aichat-v2 --query '"error"' --minutes 30 --raw
"""
import os, sys, json, time, re, argparse, calendar, datetime, warnings

warnings.filterwarnings("ignore")  # 抑制 urllib3/LibreSSL 等无关告警

try:
    from aliyun.log import LogClient, GetLogsRequest
except ImportError:
    sys.exit("缺少 SDK：python3 -m pip install aliyun-log-python-sdk")

ANSI = re.compile(r"\x1b\[[0-9;]*m")


def parse_utc(s):
    return calendar.timegm(datetime.datetime.strptime(s, "%Y-%m-%d %H:%M:%S").timetuple())


def env(k):
    v = os.environ.get(k)
    if not v:
        sys.exit(f"环境变量 {k} 未设置。请先 `source ~/.sls_creds`（见 skill 文档）。")
    return v


def main():
    ap = argparse.ArgumentParser(description="读阿里云 SLS 日志")
    ap.add_argument("--query", default="*", help="SLS 查询/分析语句（默认 *）")
    ap.add_argument("--service", help="快捷按 __tag__:_service_name_ 过滤，与 --query 用 and 组合")
    ap.add_argument("--from", dest="frm", help="起始 'YYYY-MM-DD HH:MM:SS'（UTC）")
    ap.add_argument("--to", dest="to", help="结束 'YYYY-MM-DD HH:MM:SS'（UTC）")
    ap.add_argument("--minutes", type=int, help="从现在往前 N 分钟（与 --from/--to 二选一）")
    ap.add_argument("--limit", type=int, default=100, help="最多返回行数（自动分页，默认100）")
    ap.add_argument("--reverse", action="store_true", help="时间倒序（最新在前）")
    ap.add_argument("--raw", action="store_true", help="输出原始 JSON 每行一条（不格式化、不去色）")
    ap.add_argument("--no-strip", action="store_true", help="保留 ANSI 颜色码")
    ap.add_argument("--fields", default="content", help="格式化输出时展示的正文字段（默认 content）")
    args = ap.parse_args()

    endpoint, project, logstore = env("SLS_ENDPOINT"), env("SLS_PROJECT"), env("SLS_LOGSTORE")
    client = LogClient(endpoint, env("SLS_AK_ID"), env("SLS_AK_SECRET"),
                       securityToken=os.environ.get("SLS_STS_TOKEN"))

    query = args.query
    if args.service:
        query = f'__tag__:_service_name_ : {args.service} and ({args.query})'

    now = int(time.time())
    if args.minutes:
        frm, to = now - args.minutes * 60, now
    elif args.frm and args.to:
        frm, to = parse_utc(args.frm), parse_utc(args.to)
    else:
        sys.exit("需要 --minutes 或 (--from 且 --to)")

    got, offset, page = [], 0, min(args.limit, 100)
    while len(got) < args.limit:
        req = GetLogsRequest(project, logstore, frm, to, "", query,
                             line=page, offset=offset, reverse=args.reverse)
        logs = client.get_logs(req).get_logs()
        if not logs:
            break
        for lg in logs:
            got.append(dict(lg.contents, __time__=lg.timestamp))
        offset += len(logs)
        if len(logs) < page:
            break
    got = got[:args.limit]

    for row in got:
        if args.raw:
            print(json.dumps(row, ensure_ascii=False))
            continue
        body = row.get(args.fields, "")
        if not args.no_strip:
            body = ANSI.sub("", body)
        i = body.find("spanId:")
        if i >= 0:
            body = body[i + 7:].strip()
        svc = row.get("__tag__:_service_name_", "")
        sev = row.get("severity", "")
        ts = row.get("log_time") or row.get("_time_") or ""
        print(f"{ts} [{sev}] ({svc}) {body}".rstrip())
    print(f"--- {len(got)} rows ---", file=sys.stderr)


if __name__ == "__main__":
    main()
