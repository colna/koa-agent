#!/usr/bin/env bash
# k8s-pg-query —— 通过 kubectl 进 dora-dev pod，用 pod 自带 jshell + vertx-pg-client 直连测试环境 PG 跑只读 SQL。
#
# 为什么这么做：pod 精简（只有 bash/java/jshell，无 psql/jq/python）；连接串在 pod 里 nacos 本地快照（明文）。
# 本脚本在 Mac 侧编排：kubectl 读快照 -> Mac 侧 python 解析连接串 -> 生成 .jsh -> 管道喂给 pod 内 jshell -> 过滤 log4j 噪音。
#
# 用法：
#   k8s_pg_query.sh --sql "SELECT count(*) FROM pwa_balance_msg_flow;"
#   k8s_pg_query.sh --sql-file queries/pwa4_verify.sql
#   k8s_pg_query.sh --ds monitor --sql "SELECT now();"
#   k8s_pg_query.sh --pod offline-task-service-xxx --ns dora-dev --tenant dora-dev-k8s --sql "..."
#
# 选项：
#   --sql "<多条;分隔>"    顶层按 ; 拆，逐条执行
#   --sql-file <path>      .sql/.txt=按;拆；.json=[{"name","sql"}]
#   --ds pgCfg|monitor     选连接串来源，默认 pgCfg（archat 主库）。monitor=db_monitor 库
#   --pod NAME             目标 pod；缺省自动选 offline-task-service 的 Running pod
#   --ns NS                namespace，默认 dora-dev
#   --tenant T             nacos tenant，默认 dora-dev-k8s（⚠️ 别用别的 tenant，见 SKILL.md）
#   --timeout SEC          单条查询等待秒，默认 15
#   --show-conn            额外打印连到的 host/db（不打印密码）
set -euo pipefail

NS=dora-dev; POD=""; DS=pgCfg; TENANT=dora-dev-k8s; TIMEOUT=15; SQL=""; SQLFILE=""; SHOWCONN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --ns) NS="$2"; shift 2;;
    --pod) POD="$2"; shift 2;;
    --ds) DS="$2"; shift 2;;
    --tenant) TENANT="$2"; shift 2;;
    --timeout) TIMEOUT="$2"; shift 2;;
    --sql) SQL="$2"; shift 2;;
    --sql-file) SQLFILE="$2"; shift 2;;
    --show-conn) SHOWCONN=1; shift;;
    *) echo "未知参数: $1" >&2; exit 2;;
  esac
done

# 1) 选 pod
if [ -z "$POD" ]; then
  POD=$(kubectl -n "$NS" get pods --field-selector=status.phase=Running -o name 2>/dev/null \
        | grep offline-task-service | head -1 | sed 's#pod/##')
  [ -z "$POD" ] && { echo "找不到 Running 的 offline-task-service pod，请用 --pod 指定" >&2; exit 3; }
fi

# 2) 读 nacos 快照（pin tenant，避免抓到别的 archat 实例）
CFG=$(kubectl -n "$NS" exec "$POD" -- bash -lc \
  "cat /root/nacos/config/fixed-${TENANT}-mse-*/snapshot-tenant/${TENANT}/DEFAULT_GROUP/global_db_config" \
  2>/dev/null) || { echo "读 nacos 快照失败（tenant=$TENANT，pod=$POD）" >&2; exit 3; }
[ -z "$CFG" ] && { echo "nacos 快照为空（tenant=$TENANT）" >&2; exit 3; }

# 3) Mac 侧解析连接串（host/port/db/user/pass），密码原样输出后立即 base64，避免落进命令行历史
read -r HOST PORT DB USER PASS_B64 < <(CFG_JSON="$CFG" DS="$DS" python3 - <<'PY'
import sys, os, json, base64
d = json.loads(os.environ["CFG_JSON"]); ds = os.environ["DS"]
if ds == "pgCfg":
    c = d["pgCfg"]; host, port, db, user, pw = c["host"], c.get("port",5432), c["dbName"], c["user"], c["password"]
elif ds == "monitor":
    c = d["datasource"]["monitor"]; host, port, db, user, pw = c["host"], c.get("port",5432), c["database"], c["user"], c["password"]
else:
    sys.exit("未知 --ds: " + ds)
print(host, port, db, user, base64.b64encode(pw.encode()).decode())
PY
)
[ "$SHOWCONN" = 1 ] && echo "# 连接: $USER@$HOST:$PORT/$DB (ds=$DS, pod=$POD)" >&2

# 4) 组装 (name, sql) 列表 -> 各自 base64
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
python3 - "$SQL" "$SQLFILE" > "$TMP/pairs.tsv" <<'PY'
import sys, json, base64
sql_inline, sql_file = sys.argv[1], sys.argv[2]
def split_sql(t):
    out=[]; cur=''; sq=dq=lc=bc=False; i=0; n=len(t)
    while i<n:
        c=t[i]; c2=t[i+1] if i+1<n else ''
        if lc: cur+=c; lc = c!='\n'; i+=1; continue
        if bc:
            cur+=c
            if c=='*' and c2=='/': cur+=c2; i+=2; bc=False; continue
            i+=1; continue
        if sq: cur+=c; sq = c!="'"; i+=1; continue
        if dq: cur+=c; dq = c!='"'; i+=1; continue
        if c=='-' and c2=='-': lc=True; cur+=c; i+=1; continue
        if c=='/' and c2=='*': bc=True; cur+=c+c2; i+=2; continue
        if c=="'": sq=True; cur+=c; i+=1; continue
        if c=='"': dq=True; cur+=c; i+=1; continue
        if c==';':
            s=cur.strip()
            if s: out.append(s)
            cur=''; i+=1; continue
        cur+=c; i+=1
    s=cur.strip()
    if s: out.append(s)
    # 去掉纯注释
    def strip_comments(x):
        import re
        return re.sub(r'/\*[\s\S]*?\*/','',re.sub(r'--.*','',x)).strip()
    return [s for s in out if strip_comments(s)]

pairs=[]
if sql_file:
    raw=open(sql_file,encoding='utf-8').read()
    if sql_file.endswith('.json'):
        for o in json.loads(raw): pairs.append((o.get('name','stmt'), o['sql']))
    else:
        for i,s in enumerate(split_sql(raw),1): pairs.append((f'stmt {i}', s))
else:
    for i,s in enumerate(split_sql(sql_inline),1): pairs.append((f'stmt {i}', s))

for name, sql in pairs:
    if not sql.strip(): continue
    nb=base64.b64encode(name.encode()).decode()
    sb=base64.b64encode(sql.rstrip().rstrip(';').encode()).decode()
    print(nb+'\t'+sb)
PY

[ ! -s "$TMP/pairs.tsv" ] && { echo "没有可执行的 SQL" >&2; exit 2; }

NAMES=(); SQLS=()
while IFS=$'\t' read -r nb sb; do NAMES+=("$nb"); SQLS+=("$sb"); done < "$TMP/pairs.tsv"

# 5) 生成 .jsh（SQL/密码全走 base64，杜绝转义问题；通用打印任意列）
{
  echo 'import io.vertx.pgclient.*; import io.vertx.sqlclient.*; import io.vertx.core.*; import java.util.*; import java.util.concurrent.*;'
  echo 'String B64D(String s){ return new String(Base64.getDecoder().decode(s)); }'
  echo "var vertx = Vertx.vertx();"
  echo "var opts = new PgConnectOptions().setHost(\"$HOST\").setPort($PORT).setDatabase(\"$DB\").setUser(\"$USER\").setPassword(B64D(\"$PASS_B64\")).setConnectTimeout(8000);"
  echo "var pool = PgPool.pool(vertx, opts, new PoolOptions().setMaxSize(1));"
  printf 'String[] NM = { '; for x in "${NAMES[@]}"; do printf '"%s", ' "$x"; done; echo '};'
  printf 'String[] SQ = { '; for x in "${SQLS[@]}"; do printf '"%s", ' "$x"; done; echo '};'
  cat <<JSH
for (int qi=0; qi<SQ.length; qi++) {
  String nm = B64D(NM[qi]); String sql = B64D(SQ[qi]);
  System.out.println("\n########## ["+(qi+1)+"/"+SQ.length+"] "+nm+" ##########");
  final CountDownLatch latch = new CountDownLatch(1);
  pool.query(sql).execute(ar -> {
    if (ar.succeeded()) {
      var rs = ar.result(); var names = rs.columnsNames();
      System.out.println("COLS " + String.join(" | ", names));
      System.out.println("NROWS " + rs.size());
      for (var row : rs) {
        StringBuilder sb = new StringBuilder("ROW ");
        for (int i=0;i<names.size();i++){ Object v = row.getValue(i); sb.append(names.get(i)).append("=").append(v==null?"NULL":v.toString()); if(i<names.size()-1) sb.append("  "); }
        System.out.println(sb.toString());
      }
    } else { System.out.println("ERROR " + ar.cause().getMessage()); }
    latch.countDown();
  });
  latch.await($TIMEOUT, TimeUnit.SECONDS);
}
System.exit(0);
JSH
} > "$TMP/q.jsh"

# 6) 喂给 pod 内 jshell，过滤 log4j / agent 噪音（都在 stderr + 无关行）
kubectl -n "$NS" exec -i "$POD" -- jshell --class-path '/app/resources:/app/classes:/app/libs/*' -q - \
  < "$TMP/q.jsh" 2>/dev/null \
  | grep -E '^(#{5,}|COLS |NROWS |ROW |ERROR )'
