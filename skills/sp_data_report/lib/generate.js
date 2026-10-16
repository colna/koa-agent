#!/usr/bin/env node
// One-shot: curl -> parse -> run all SQL templates over DMS websql WS -> HTML report.
// Requires Node >= 22 (global WebSocket).
//
// Usage:
//   node generate.js --curl <curl.txt> [options]
//   node generate.js --cookie-file <f> --ws <wss://...> [options]
//
// Options (all optional; sensible defaults):
//   --curl <file>         file containing the copied `curl` command (extracts ws url + cookie)
//   --cookie-file <file>  cookie string file (alternative to --curl)
//   --ws <url>            websocket url (default: wss://dms-us-west-1.alibabacloud.com/ws/newwebsql/query)
//   --week-start <date>   inclusive window start YYYY-MM-DD (default: today-7)
//   --end-date <date>     window end label YYYY-MM-DD (default: today)
//   --dist-day <date>     representative day for duration pie (default: today-1)
//   --db-id <n>           DMS dbId (default: 80163632)
//   --db-type <t>         db type (default: postgresql)
//   --out <file>          HTML output path (default: ./sp_report_<weekStart>.html)
//   --data-out <file>     raw results JSON output path (default: ./sp_report_data.json)
const fs = require('fs');
const path = require('path');
const { parseCurl } = require('./parse_curl');
const buildQueries = require('./queries');
const { runReports } = require('./run_reports');
const { renderHtml } = require('./generate_html');

function arg(name, def) { const i = process.argv.indexOf('--' + name); return i > -1 ? process.argv[i + 1] : def; }
function ymd(d) { return d.toISOString().slice(0, 10); }
function daysAgo(n) { const d = new Date(); d.setDate(d.getDate() - n); return ymd(d); }

(async () => {
  const DEFAULT_WS = 'wss://dms-us-west-1.alibabacloud.com/ws/newwebsql/query';
  let url = arg('ws', DEFAULT_WS);
  let cookie = null;

  const curlFile = arg('curl');
  if (curlFile) {
    const parsed = parseCurl(fs.readFileSync(curlFile, 'utf8'));
    url = parsed.url || url;
    cookie = parsed.cookie;
  }
  const cookieFile = arg('cookie-file');
  if (cookieFile) cookie = fs.readFileSync(cookieFile, 'utf8').trim();
  if (!cookie) { console.error('ERROR: need --curl <file> or --cookie-file <file>'); process.exit(1); }

  const weekStart = arg('week-start', daysAgo(7));
  const endDate = arg('end-date', daysAgo(0));
  const distDay = arg('dist-day', daysAgo(1));
  const dbId = Number(arg('db-id', 80163632));
  const dbType = arg('db-type', 'postgresql');
  const out = arg('out', path.resolve(`sp_report_${weekStart}.html`));
  const dataOut = arg('data-out', path.resolve('sp_report_data.json'));

  console.error(`[sp_data_report] window ${weekStart} ~ ${endDate}, distDay ${distDay}, dbId ${dbId}`);
  const queries = buildQueries({ weekStart, distDay });
  const results = await runReports(queries, { url, cookie, dbId, dbType },
    (id, st) => { if (st !== 'start') process.stderr.write(`  ${id}: ${st}\n`); });

  fs.writeFileSync(dataOut, JSON.stringify({ meta: { weekStart, endDate, distDay }, results }, null, 2));
  const html = renderHtml(results, { weekStart, endDate, distDay }, path.join(__dirname, 'echarts.min.js'));
  fs.writeFileSync(out, html);
  console.error(`\n[sp_data_report] DONE`);
  console.log(JSON.stringify({ ok: true, out, dataOut, weekStart, endDate, distDay, queries: queries.length }));
})().catch(e => { console.error('FATAL', e && e.stack || e); process.exit(1); });
