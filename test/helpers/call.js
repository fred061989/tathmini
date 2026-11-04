const { Readable } = require('node:stream');

// Invokes a Node (req, res) handler and resolves with { status, body, headers }.
function call(handler, method, url, body, headers = {}) {
  const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
  Object.assign(req, { method, url, headers });
  return new Promise(resolve => {
    const res = {
      statusCode: 200, headers: {}, writableEnded: false,
      setHeader(k, v) { this.headers[k] = v; },
      end(data) { this.writableEnded = true; resolve({ status: this.statusCode, body: data ? JSON.parse(data) : null, headers: this.headers }); },
    };
    handler(req, res);
  });
}

module.exports = { call };
