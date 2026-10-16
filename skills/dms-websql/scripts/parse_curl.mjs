#!/usr/bin/env node
/*
 * 从粘贴的 DMS curl（WS 握手 curl，可含 payload）里抽出 Cookie / host / dbId / dbType，
 * 把 Cookie 写进 --out 指定的文件（chmod 600），其余打到 stdout 供上层拼命令。
 *
 * 用法：
 *   node parse_curl.mjs --curl-file curl.txt --out /path/cookie.txt
 *   pbpaste | node parse_curl.mjs --out /path/cookie.txt        # 从 stdin 读
 *
 * 输出（shell 可 eval 的 KEY=VALUE，Cookie 不打印，只落盘）：
 *   DMS_HOST=dms-us-west-1.alibabacloud.com
 *   DMS_DBID=80166415        # 若 curl 里带 payload 才有
 *   DMS_DBTYPE=postgresql    # 同上
 *   DMS_COOKIE_FILE=/path/cookie.txt
 */
import fs from 'node:fs';

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}
const out = arg('--out', '');
if (!out) { console.error('必须给 --out <cookie 落盘路径>'); process.exit(2); }

const cf = arg('--curl-file', '');
const text = cf ? fs.readFileSync(cf, 'utf8') : fs.readFileSync(0, 'utf8');

// Cookie：优先 -b/--cookie，其次 -H 'Cookie: ...'
function grabQuoted(afterRe) {
  const m = text.match(afterRe);
  return m ? m[1] : null;
}
let cookie =
  grabQuoted(/(?:^|\s)(?:-b|--cookie)\s+'([^']*)'/) ||
  grabQuoted(/(?:^|\s)(?:-b|--cookie)\s+"([^"]*)"/) ||
  grabQuoted(/-H\s+'Cookie:\s*([^']*)'/i) ||
  grabQuoted(/-H\s+"Cookie:\s*([^"]*)"/i);
if (!cookie) { console.error('没在 curl 里找到 Cookie（-b / --cookie / -H Cookie:）'); process.exit(3); }
cookie = cookie.trim();

// host：从 wss:// 或 https:// URL 里取
const urlM = text.match(/\b(?:wss|https):\/\/([^/\s'"]+)/i);
const host = urlM ? urlM[1] : 'dms-us-west-1.alibabacloud.com';

// dbId / dbType：若 curl 里粘了 payload
const dbIdM = text.match(/"dbId"\s*:\s*(\d+)/);
const dbTypeM = text.match(/"dbType"\s*:\s*"([^"]+)"/);

fs.writeFileSync(out, cookie, { mode: 0o600 });
try { fs.chmodSync(out, 0o600); } catch {}

console.log('DMS_HOST=' + host);
if (dbIdM) console.log('DMS_DBID=' + dbIdM[1]);
if (dbTypeM) console.log('DMS_DBTYPE=' + dbTypeM[1]);
console.log('DMS_COOKIE_FILE=' + out);
console.error(`已写入 Cookie -> ${out} (0600)，host=${host}${dbIdM ? ', dbId=' + dbIdM[1] : ''}`);
