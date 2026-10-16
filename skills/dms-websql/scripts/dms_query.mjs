#!/usr/bin/env node
/*
 * 阿里云 DMS newwebsql 查询客户端（WebSocket）。
 * 用 Node 内置 tls+crypto 手写最小 WS 客户端（不装任何依赖），复用浏览器抓到的登录 Cookie 直连 DMS，
 * 在测试/线上库跑只读 SQL 并把结果打成可读表格。
 *
 * 为什么手写 WS：Node 全局 WebSocket(undici) 不允许设置 Cookie 头，连不上；DMS 又要求 HTTP/1.1 升级
 *（HTTP/2 会被 302 到 err.taobao.com）。手写 TLS 升级可完全控制头 + 强制 http/1.1，实测稳定。
 *
 * 凭证：Cookie 从 --cookie-file（默认 $DMS_COOKIE 环境变量）读，绝不写进脚本/仓库。
 *
 * 用法：
 *   DMS_COOKIE="$(cat cookie.txt)" node dms_query.mjs --db-id 80166415 --sql "SELECT 1;"
 *   node dms_query.mjs --cookie-file cookie.txt --db-id 80166415 --sql-file pack.json
 *   node dms_query.mjs --db-id 80166415 --host dms-us-west-1.alibabacloud.com --db-type postgresql --sql "..."
 *
 * SQL 输入（三选一）：
 *   --sql "<多条;分隔>"     顶层按 ; 拆成多条，逐条执行（引号/注释安全）
 *   --sql-file <path>       .json = [{"name","sql"}, ...]；.sql/.txt = 原文按 ; 拆
 *   (stdin)                 无上述参数时从 stdin 读 SQL 文本
 *
 * 选项：
 *   --db-id N        (必填) DMS 里目标库的 dbId（见 SKILL.md「怎么拿 dbId」）
 *   --host H         默认 dms-us-west-1.alibabacloud.com（按 region 改，如 dms.aliyuncs.com）
 *   --db-type T      默认 postgresql（mysql / polardb 等）
 *   --cookie-file P  Cookie 文件；缺省读 $DMS_COOKIE
 *   --timeout MS     整体超时，默认 40000
 *   --json           每条结果输出原始 JSON（下游 jq/py 处理），不打表格
 *   --no-split       把 --sql / stdin 当成整体一次性发送，不按 ; 拆
 */
import tls from 'node:tls';
import crypto from 'node:crypto';
import fs from 'node:fs';

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}
const has = (name) => process.argv.includes(name);

const HOST = arg('--host', 'dms-us-west-1.alibabacloud.com');
const PATH = '/ws/newwebsql/query';
const DBID = Number(arg('--db-id', ''));
const DBTYPE = arg('--db-type', 'postgresql');
const TIMEOUT = Number(arg('--timeout', '40000'));
const RAW_JSON = has('--json');
const NO_SPLIT = has('--no-split');

if (!DBID) { console.error('错误：必须给 --db-id（DMS 里目标库的 dbId）'); process.exit(2); }

// ---- 读 Cookie ----
let cookie = '';
const cf = arg('--cookie-file', '');
if (cf) cookie = fs.readFileSync(cf, 'utf8').trim();
else if (process.env.DMS_COOKIE) cookie = process.env.DMS_COOKIE.trim();
if (!cookie) { console.error('错误：没有 Cookie。用 --cookie-file <文件> 或设置 $DMS_COOKIE 环境变量'); process.exit(2); }

// ---- 顶层按 ; 拆 SQL（跳过 '...'、"..."、-- 行注释、/* */ 块注释里的 ;）----
function splitSql(text) {
  const out = [];
  let cur = '', i = 0, n = text.length;
  let sq = false, dq = false, lc = false, bc = false;
  while (i < n) {
    const c = text[i], c2 = text[i + 1];
    if (lc) { cur += c; if (c === '\n') lc = false; i++; continue; }
    if (bc) { cur += c; if (c === '*' && c2 === '/') { cur += c2; i += 2; bc = false; continue; } i++; continue; }
    if (sq) { cur += c; if (c === "'") sq = false; i++; continue; }
    if (dq) { cur += c; if (c === '"') dq = false; i++; continue; }
    if (c === '-' && c2 === '-') { lc = true; cur += c; i++; continue; }
    if (c === '/' && c2 === '*') { bc = true; cur += c + c2; i += 2; continue; }
    if (c === "'") { sq = true; cur += c; i++; continue; }
    if (c === '"') { dq = true; cur += c; i++; continue; }
    if (c === ';') { const t = cur.trim(); if (t) out.push(t + ';'); cur = ''; i++; continue; }
    cur += c; i++;
  }
  const t = cur.trim();
  if (t) out.push(t.endsWith(';') ? t : t + ';');
  // 去掉纯注释块
  return out.filter(s => s.replace(/--.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').trim());
}

// ---- 组装 queries: [{name, sql}] ----
let queries = [];
const sqlInline = arg('--sql', null);
const sqlFile = arg('--sql-file', null);
if (sqlFile) {
  const raw = fs.readFileSync(sqlFile, 'utf8');
  if (sqlFile.endsWith('.json')) queries = JSON.parse(raw);
  else queries = (NO_SPLIT ? [raw] : splitSql(raw)).map((s, i) => ({ name: `stmt ${i + 1}`, sql: s }));
} else {
  let raw = sqlInline;
  if (raw == null) raw = fs.readFileSync(0, 'utf8'); // stdin
  queries = (NO_SPLIT ? [raw] : splitSql(raw)).map((s, i) => ({ name: `stmt ${i + 1}`, sql: s }));
}
queries = queries.filter(q => q && q.sql && q.sql.trim());
if (!queries.length) { console.error('错误：没有可执行的 SQL'); process.exit(2); }

function mkPayload(sql) {
  return JSON.stringify({
    type: 'execute',
    data: { sql, dbId: DBID, logic: false, characterType: '', switchedHostPort: '', ignoreConfirm: false,
      blobDirectDisplay: false, blobToHex: false, binaryToHex: false, sessionPersistence: false,
      dbType: DBTYPE, excutionAbort: false },
    token: '',
  });
}

// ---- 最小 WebSocket 客户端 ----
const key = crypto.randomBytes(16).toString('base64');
const sock = tls.connect({ host: HOST, port: 443, servername: HOST, ALPNProtocols: ['http/1.1'] }, () => {
  sock.write(
    `GET ${PATH} HTTP/1.1\r\nHost: ${HOST}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
    `Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${key}\r\nOrigin: https://${HOST}\r\n` +
    `User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36\r\n` +
    `Cookie: ${cookie}\r\n\r\n`);
});

let handshakeDone = false, buf = Buffer.alloc(0), fragOp = 0, fragBuf = Buffer.alloc(0), qi = -1;
let exitCode = 0;

function sendFrame(str) {
  const data = Buffer.from(str, 'utf8'), mask = crypto.randomBytes(4), len = data.length;
  let header;
  if (len < 126) header = Buffer.from([0x81, 0x80 | len]);
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0xFE; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 0xFF; header.writeUInt32BE(0, 2); header.writeUInt32BE(len, 6); }
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i++) masked[i] = data[i] ^ mask[i & 3];
  sock.write(Buffer.concat([header, mask, masked]));
}

function next() {
  qi++;
  if (qi >= queries.length) { sock.end(); process.exit(exitCode); }
  if (!RAW_JSON) console.log(`\n########## [${qi + 1}/${queries.length}] ${queries[qi].name} ##########`);
  sendFrame(mkPayload(queries[qi].sql));
}

function printResult(rs) {
  if (!rs) { console.log('(无结果集)'); return; }
  const cols = rs.columns || [];
  const names = cols.map(c => c.realName || c.field);
  console.log('columns: ' + names.join(' | '));
  console.log('rows: ' + rs.count + (rs.rtnRowsInfo ? '  (' + rs.rtnRowsInfo.replace(/\s+/g, ' ').trim() + ')' : ''));
  for (const r of (rs.result || [])) {
    console.log('  ' + cols.map(c => {
      const nm = c.realName || c.field;
      const v = r[c.field] !== undefined ? r[c.field] : r[nm];
      return nm + '=' + (v === null || v === undefined ? 'NULL' : v);
    }).join('  '));
  }
}

function onMessage(msg) {
  let o; try { o = JSON.parse(msg); } catch { if (RAW_JSON) console.log(msg); else console.log('<<< (非JSON) ' + msg.slice(0, 300)); return; }
  if (o.type === 'execResult') {
    if (RAW_JSON) { console.log(JSON.stringify(o.data)); }
    else {
      const d = o.data || {}, rs = d.resultSet || {};
      if (d.success === false || rs.executeSuccess === false) {
        exitCode = 1;
        const em = (rs.message || d.message || '').replace(/<br>/g, '\n').replace(/<[^>]+>/g, '').trim();
        console.log('ERROR: ' + em);
      } else printResult(rs);
    }
    next();
  } else if (o.type === 'execResError' || o.type === 'error') {
    exitCode = 1;
    console.log('EXEC_ERROR: ' + JSON.stringify(o.data));
    next();
  }
  // 忽略 execResList / execResQueryId 等中间消息
}

function parseFrames() {
  while (buf.length >= 2) {
    const b0 = buf[0], b1 = buf[1];
    const fin = (b0 & 0x80) !== 0, opcode = b0 & 0x0f, masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f, off = 2;
    if (len === 126) { if (buf.length < off + 2) return; len = buf.readUInt16BE(off); off += 2; }
    else if (len === 127) { if (buf.length < off + 8) return; len = Number(buf.readBigUInt64BE(off)); off += 8; }
    let mk; if (masked) { if (buf.length < off + 4) return; mk = buf.slice(off, off + 4); off += 4; }
    if (buf.length < off + len) return;
    let p = buf.slice(off, off + len);
    if (masked) { const u = Buffer.alloc(len); for (let i = 0; i < len; i++) u[i] = p[i] ^ mk[i & 3]; p = u; }
    buf = buf.slice(off + len);
    if (opcode === 0x8) { sock.end(); return; }
    if (opcode === 0x9 || opcode === 0xA) continue;
    if (opcode === 0x0) fragBuf = Buffer.concat([fragBuf, p]); else { fragOp = opcode; fragBuf = p; }
    if (fin) { if (fragOp === 0x1) onMessage(fragBuf.toString('utf8')); fragBuf = Buffer.alloc(0); }
  }
}

sock.on('data', (chunk) => {
  if (!handshakeDone) {
    buf = Buffer.concat([buf, chunk]);
    const idx = buf.indexOf('\r\n\r\n'); if (idx === -1) return;
    const head = buf.slice(0, idx).toString('utf8');
    if (!/ 101 /.test(head)) {
      console.error('握手失败（Cookie 可能过期/无权限）：\n' + head.split('\r\n')[0]);
      sock.end(); process.exit(3);
    }
    handshakeDone = true; buf = buf.slice(idx + 4);
    setTimeout(next, 300); parseFrames();
  } else { buf = Buffer.concat([buf, chunk]); parseFrames(); }
});
sock.on('error', (e) => { console.error('SOCK_ERR ' + e.message); process.exit(3); });
sock.on('close', () => process.exit(exitCode));
setTimeout(() => { console.error('=== 超时退出 ==='); sock.end(); process.exit(exitCode || 4); }, TIMEOUT);
