// Minimal HTTP helpers that work both on Vercel and under plain Node (server.js).

class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function redirect(res, location) {
  res.statusCode = 302;
  res.setHeader('Location', location);
  res.end();
}

async function readJson(req) {
  if (req.body !== undefined) {
    if (typeof req.body === 'string') return req.body ? JSON.parse(req.body) : {};
    if (Buffer.isBuffer(req.body)) return req.body.length ? JSON.parse(req.body.toString('utf8')) : {};
    return req.body || {};
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw new HttpError(413, 'Request body too large');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new HttpError(400, 'Request body must be JSON');
  }
}

function required(obj, fields) {
  const missing = fields.filter(f => obj[f] == null || obj[f] === '');
  if (missing.length) throw new HttpError(400, `Missing: ${missing.join(', ')}`);
}

// Routes: [method, '/api/things/:id', handler]. Handler gets { req, res, params, query }.
function createRouter(routes) {
  const compiled = routes.map(([method, path, handler]) => {
    const keys = [];
    const re = new RegExp('^' + path.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
    return { method, re, keys, handler };
  });

  return async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    try {
      let pathMatched = false;
      for (const r of compiled) {
        const m = url.pathname.match(r.re);
        if (!m) continue;
        pathMatched = true;
        if (r.method !== req.method) continue;
        const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
        const out = await r.handler({ req, res, params, query: Object.fromEntries(url.searchParams) });
        if (!res.writableEnded) send(res, 200, out ?? { ok: true });
        return;
      }
      throw new HttpError(pathMatched ? 405 : 404, pathMatched ? 'Method not allowed' : 'Not found');
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) console.error(err);
      if (!res.writableEnded) send(res, status, { error: err.status ? err.message : 'Server error', details: err.details });
    }
  };
}

module.exports = { HttpError, send, redirect, readJson, required, createRouter };
