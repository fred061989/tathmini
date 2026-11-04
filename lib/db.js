const { createClient } = require('@supabase/supabase-js');
const { HttpError } = require('./http');

let client;
function db() {
  if (!client) {
    client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return client;
}

// Unwraps a Supabase response, throwing on error.
function must({ data, error }) {
  if (error) {
    if (error.code === '23505') throw new HttpError(409, 'That record already exists', error.details);
    if (error.code === '23503') throw new HttpError(400, 'Referenced record not found', error.details);
    throw new Error(`Database error: ${error.message}`);
  }
  return data;
}

function one(res, what = 'Record') {
  const data = must(res);
  if (!data) throw new HttpError(404, `${what} not found`);
  return data;
}

module.exports = { db, must, one };
