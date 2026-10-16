// Run a list of {id, sql, ...} queries against an Alibaba DMS websql WebSocket.
// One fresh WebSocket connection per query (simplest & most reliable). Requires
// Node >= 22 (global WebSocket). Returns a { [id]: {columns, rows, ...} } map.

function runQuery(q, { url, cookie, dbId, dbType }) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, {
      headers: {
        'Origin': new URL(url.replace(/^ws/, 'http')).origin,
        'Cookie': cookie,
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'Cache-Control': 'no-cache', 'Pragma': 'no-cache',
      },
    });
    const msg = { type: 'execute', data: {
      sql: q.sql, dbId, logic: false, characterType: '', switchedHostPort: '',
      ignoreConfirm: false, blobDirectDisplay: false, blobToHex: false, binaryToHex: false,
      sessionPersistence: false, dbType, excutionAbort: false }, token: '' };
    const to = setTimeout(() => { try { ws.close(); } catch (e) {} resolve({ id: q.id, error: 'timeout' }); }, 60000);
    ws.addEventListener('open', () => ws.send(JSON.stringify(msg)));
    ws.addEventListener('error', (e) => { clearTimeout(to); resolve({ id: q.id, error: String(e && (e.message || e)) }); });
    ws.addEventListener('message', (ev) => {
      const data = typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8');
      let m; try { m = JSON.parse(data); } catch (e) { return; }
      if (m.data && m.data.resultSet) {
        const rs = m.data.resultSet;
        const cols = rs.columns.map(c => c.realName || c.title || c.field);
        const fields = rs.columns.map(c => c.field);
        const rows = (rs.result || []).map(r => { const o = {}; cols.forEach((c, i) => o[c] = r[fields[i]]); return o; });
        clearTimeout(to); try { ws.close(); } catch (e) {}
        resolve({ id: q.id, title: q.title, kind: q.kind, columns: cols, rows, count: rs.count, success: rs.executeSuccess, message: rs.message });
      }
    });
  });
}

// Run all queries sequentially; logs progress to stderr.
async function runReports(queries, conn, onProgress) {
  const results = {};
  for (const q of queries) {
    if (onProgress) onProgress(q.id, 'start');
    const r = await runQuery(q, conn);
    results[q.id] = r;
    if (onProgress) onProgress(q.id, r.error ? ('ERROR ' + r.error) : ('ok ' + (r.rows ? r.rows.length : 0) + ' rows'));
  }
  return results;
}

module.exports = { runQuery, runReports };
