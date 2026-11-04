// School billing: what is paid for, paying for one, some or all learners by the term or the
// year (M-Pesa, with the confirmation code), and the owner's checks of those payments.

const { db, must } = require('../db');
const { HttpError, readJson } = require('../http');
const { requireAdmin, requireOwner } = require('../auth');
const { prices, payTo, currentPeriod, coverage, quote, payForLearners, checkPayment, TERMS } = require('../billing');
const { addPaidLearnersToSheets } = require('./assessments');

function parseChoice(src) {
  const now = currentPeriod();
  const year = Number(src.year || now.year);
  const term = Number(src.term || now.term);
  if (!Number.isInteger(year) || !(term >= 1 && term <= 3)) throw new HttpError(400, 'Choose a year and a term (1–3)');
  return { year, term, plan: src.plan === 'year' ? 'year' : 'term' };
}

async function activeLearners(schoolId) {
  return must(await db().from('learners').select('id, first_name, last_name, adm_no, class_id, classes(grade, stream, year)')
    .eq('school_id', schoolId).eq('active', true).order('first_name').order('last_name'));
}

// Which learners a payment is for: given ids (that belong to the school), or every unpaid learner.
async function chosenLearners(schoolId, body) {
  const all = await activeLearners(schoolId);
  if (body.learner_ids === 'unpaid' || body.learner_ids == null) return all.map(l => l.id);
  const mine = new Set(all.map(l => l.id));
  if (!Array.isArray(body.learner_ids)) throw new HttpError(400, 'Choose learners');
  const ids = [...new Set(body.learner_ids)];
  if (!ids.length || ids.some(id => !mine.has(id))) throw new HttpError(400, 'Choose learners from this school');
  return ids;
}

const PAYMENT_FIELDS = 'id, description, amount_cents, mpesa_code, status, note, created_at, checked_at';

const routes = [
  // Prices, where to pay, who is paid for a term (default: the current term), and past payments.
  ['GET', '/api/billing', async ({ req, query }) => {
    const admin = await requireAdmin(req);
    const { year, term } = parseChoice(query);
    const [learners, covered, payments] = await Promise.all([
      activeLearners(admin.school_id),
      coverage(admin.school_id, year),
      db().from('payments').select(PAYMENT_FIELDS).eq('school_id', admin.school_id).order('created_at', { ascending: false }).limit(30).then(must),
    ]);
    const unpaid = learners.filter(l => !covered.get(l.id)?.has(term));
    const ids = unpaid.map(l => l.id);
    return {
      prices: prices(),
      pay_to: payTo(admin.school_id),
      year, term,
      current: currentPeriod(),
      learners: learners.length,
      paid: learners.length - unpaid.length,
      unpaid: unpaid.map(l => ({ id: l.id, name: `${l.first_name} ${l.last_name}`, adm_no: l.adm_no, class_id: l.class_id })),
      // What paying for everyone unpaid would cost, either way.
      quotes: {
        term: quote(ids, covered, { term, plan: 'term' }).total_cents,
        year: quote(ids, covered, { term, plan: 'year' }).total_cents,
      },
      payments,
    };
  }],

  // What a payment would cost. Body: { learner_ids: [...] | 'unpaid', year, term, plan: 'term' | 'year' }
  ['POST', '/api/billing/quote', async ({ req }) => {
    const admin = await requireAdmin(req);
    const body = await readJson(req);
    const choice = parseChoice(body);
    const q = quote(await chosenLearners(admin.school_id, body), await coverage(admin.school_id, choice.year), choice);
    return { ...choice, learners: q.learners, total_cents: q.total_cents, pay_to: payTo(admin.school_id) };
  }],

  // Records an M-Pesa payment and unlocks the learners. Same body as the quote, plus mpesa_code.
  ['POST', '/api/billing/pay', async ({ req }) => {
    const admin = await requireAdmin(req);
    const body = await readJson(req);
    const choice = parseChoice(body);
    const ids = await chosenLearners(admin.school_id, body);
    const p = await payForLearners(admin.school_id, ids, choice, body.mpesa_code, admin.email);
    // Newly paid learners go straight onto the teachers' sheets already sent for those terms.
    const terms = choice.plan === 'year' ? TERMS : [choice.term];
    const sheets = await addPaidLearnersToSheets(admin.school_id, ids, terms.map(term => ({ year: choice.year, term })));
    return { ...choice, learners: p.learners, amount_cents: p.amount_cents, payment: p, sheets_updated: sheets.sheets, held_sent: sheets.sent, sheet_errors: sheets.errors };
  }],

  // Owner: every school, its learners and what it has paid.
  ['GET', '/api/owner/schools', async ({ req }) => {
    await requireOwner(req);
    const now = currentPeriod();
    const [schools, learners, paid, payments] = await Promise.all([
      db().from('schools').select('id, name, county, phone, email, created_at').order('created_at', { ascending: false }).then(must),
      db().from('learners').select('school_id').eq('active', true).then(must),
      db().from('learner_terms').select('school_id').eq('year', now.year).eq('term', now.term).then(must),
      db().from('payments').select('school_id, amount_cents, status').then(must),
    ]);
    const count = (rows, id) => rows.filter(r => r.school_id === id).length;
    const sum = (id, st) => payments.filter(p => p.school_id === id && p.status === st).reduce((n, p) => n + p.amount_cents, 0);
    return schools.map(s => ({
      ...s, account: payTo(s.id).account, learners: count(learners, s.id), learners_paid_this_term: count(paid, s.id), period: now,
      confirmed_cents: sum(s.id, 'confirmed'), pending_cents: sum(s.id, 'pending'),
    }));
  }],

  // Owner: payments to check against the M-Pesa statement (awaiting check first).
  ['GET', '/api/owner/payments', async ({ req, query }) => {
    await requireOwner(req);
    let q = db().from('payments').select(`${PAYMENT_FIELDS}, school_id, schools(name)`).order('created_at', { ascending: false }).limit(200);
    if (query.status) q = q.eq('status', query.status);
    return must(await q).map(p => ({ ...p, account: payTo(p.school_id).account }));
  }],

  // Owner: the money arrived. Body: { note? }
  ['POST', '/api/owner/payments/:id/confirm', async ({ req, params }) => {
    const owner = await requireOwner(req);
    return checkPayment(params.id, true, owner.email, (await readJson(req)).note);
  }],

  // Owner: no such M-Pesa payment; the learners are locked again. Body: { note? }
  ['POST', '/api/owner/payments/:id/reject', async ({ req, params }) => {
    const owner = await requireOwner(req);
    return checkPayment(params.id, false, owner.email, (await readJson(req)).note);
  }],
];

module.exports = { routes };
