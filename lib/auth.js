// Sign-in via Supabase Auth (email sign-in link).
// Only school admins (and the platform owner) use the app; teachers never sign in,
// they just fill in the Google Sheets shared with them.

const crypto = require('crypto');
const { db, must } = require('./db');
const { HttpError } = require('./http');

async function authUser(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) throw new HttpError(401, 'Sign in required');
  const { data, error } = await db().auth.getUser(token);
  if (error || !data?.user) throw new HttpError(401, 'Session expired, sign in again');
  return data.user;
}

// The admin row for the signed-in user, linking an invited admin by email on first sign-in.
async function findStaff(user) {
  let staff = must(await db().from('staff').select('*').eq('user_id', user.id).eq('role', 'admin').eq('active', true).maybeSingle());
  if (staff) return staff;
  const email = (user.email || '').toLowerCase();
  if (!email) return null;
  const invited = must(await db().from('staff').select('*').ilike('email', email).is('user_id', null)
    .eq('role', 'admin').eq('active', true).limit(1));
  if (!invited.length) return null;
  return must(await db().from('staff').update({ user_id: user.id }).eq('id', invited[0].id).select().single());
}

// PLATFORM_OWNER_EMAILS: comma-separated sign-in emails of the platform owner(s).
function isOwner(user) {
  const owners = String(process.env.PLATFORM_OWNER_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
  return Boolean(user?.email) && owners.includes(user.email.toLowerCase());
}

async function requireOwner(req) {
  const user = await authUser(req);
  if (!isOwner(user)) throw new HttpError(403, 'Only the platform owner can do this');
  return user;
}

async function requireAdminOrOwner(req) {
  const user = await authUser(req);
  if (isOwner(user)) return { user, owner: true };
  const staff = await findStaff(user);
  if (!staff) throw new HttpError(403, 'This account is not an admin of any school');
  return { user, staff, owner: false };
}

async function requireAdmin(req) {
  const user = await authUser(req);
  const staff = await findStaff(user);
  if (!staff) throw new HttpError(403, 'This account is not an admin of any school');
  return staff;
}

// Signed state for the Google sign-in round trip.
function signState(payload) {
  const body = Buffer.from(JSON.stringify({ ...payload, t: Date.now() })).toString('base64url');
  const sig = crypto.createHmac('sha256', process.env.STATE_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyState(state, maxAgeMs = 15 * 60 * 1000) {
  const [body, sig] = String(state || '').split('.');
  if (!body || !sig) throw new HttpError(400, 'Invalid state');
  const expected = crypto.createHmac('sha256', process.env.STATE_SECRET).update(body).digest('base64url');
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    throw new HttpError(400, 'Invalid state');
  }
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  if (Date.now() - payload.t > maxAgeMs) throw new HttpError(400, 'Link expired, try connecting again');
  return payload;
}

module.exports = { authUser, findStaff, isOwner, requireOwner, requireAdminOrOwner, requireAdmin, signState, verifyState };
