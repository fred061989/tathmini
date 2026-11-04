// Connecting the school's Google account, in which assessment sheets are created.

const { db, must } = require('../db');
const { HttpError, redirect } = require('../http');
const { requireAdmin, signState, verifyState } = require('../auth');
const sheets = require('../sheets');

const routes = [
  ['GET', '/api/google/connect', async ({ req }) => {
    const admin = await requireAdmin(req);
    return { url: sheets.authUrl(signState({ school_id: admin.school_id })) };
  }],

  // Google redirects the browser here, so there is no bearer token; the signed state identifies the school.
  ['GET', '/api/google/callback', async ({ res, query }) => {
    if (query.error) return redirect(res, `/app.html#settings?google=${encodeURIComponent(query.error)}`);
    const { school_id } = verifyState(query.state);
    const { refreshToken, email } = await sheets.exchangeCode(query.code);
    if (!refreshToken) throw new HttpError(400, 'Google did not return offline access; remove the app from your Google account and connect again');
    must(await db().from('schools').update({ google_refresh_token: refreshToken, google_email: email }).eq('id', school_id));
    return redirect(res, '/app.html#settings?google=connected');
  }],

  ['POST', '/api/google/disconnect', async ({ req }) => {
    const admin = await requireAdmin(req);
    must(await db().from('schools').update({ google_refresh_token: null, google_email: null }).eq('id', admin.school_id));
  }],
];

module.exports = { routes };
