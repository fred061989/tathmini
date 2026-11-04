// Local development server: serves public/ and routes /api/* to the API handler.
// Usage: npm run dev   (reads .env if present)

const http = require('http');
const fs = require('fs');
const path = require('path');

if (fs.existsSync('.env')) {
  for (const line of fs.readFileSync('.env', 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const api = require('./api/index');
const SECURITY_HEADERS = require('./lib/security-headers.json');
const PUBLIC = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

http.createServer((req, res) => {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (k !== 'Strict-Transport-Security') res.setHeader(k, v);
  if (req.url.startsWith('/api/')) return api(req, res);
  const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const file = path.join(PUBLIC, urlPath === '/' ? 'index.html' : urlPath);
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.statusCode = 404;
    return res.end('Not found');
  }
  res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
}).listen(process.env.PORT || 3000, () => console.log(`Tathmini running on http://localhost:${process.env.PORT || 3000}`));
