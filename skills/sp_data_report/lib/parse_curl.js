// Parse a browser-copied `curl` command (DMS websql websocket) into {url, cookie}.
// Handles both `-b '...'` / `--cookie '...'` and `-H 'Cookie: ...'` forms,
// and single- or double-quoted args.
function parseCurl(text) {
  // Normalize line continuations
  const t = text.replace(/\\\r?\n/g, ' ');

  // 1) WebSocket / HTTP URL: first ws(s):// or http(s):// token, quoted or bare
  let url = null;
  const urlQuoted = t.match(/['"](wss?:\/\/[^'"]+|https?:\/\/[^'"]+)['"]/);
  if (urlQuoted) url = urlQuoted[1];
  if (!url) {
    const urlBare = t.match(/\b(wss?:\/\/\S+|https?:\/\/\S+)/);
    if (urlBare) url = urlBare[1].replace(/['"]$/, '');
  }
  // Force ws scheme for the websocket endpoint if given as http(s)
  if (url) url = url.replace(/^http:\/\//, 'ws://').replace(/^https:\/\//, 'wss://');

  // 2) Cookie via -b / --cookie
  let cookie = null;
  const b = t.match(/(?:-b|--cookie)\s+'([^']*)'/) || t.match(/(?:-b|--cookie)\s+"([^"]*)"/);
  if (b) cookie = b[1];
  // 3) Cookie via -H 'Cookie: ...'
  if (!cookie) {
    const hc = t.match(/-H\s+'cookie:\s*([^']*)'/i) || t.match(/-H\s+"cookie:\s*([^"]*)"/i);
    if (hc) cookie = hc[1];
  }

  if (!url) throw new Error('parse_curl: no ws/http URL found in curl');
  if (!cookie) throw new Error('parse_curl: no cookie found (need -b or -H Cookie)');
  return { url: url.trim(), cookie: cookie.trim() };
}

module.exports = { parseCurl };

// CLI: node parse_curl.js <curl-file>  -> prints JSON {url, cookie}
if (require.main === module) {
  const fs = require('fs');
  const file = process.argv[2];
  const text = file ? fs.readFileSync(file, 'utf8') : fs.readFileSync(0, 'utf8');
  console.log(JSON.stringify(parseCurl(text), null, 2));
}
