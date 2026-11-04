// School billing (Phase 1): account balance, paying for learners by the term or the year,
// account activity. Schools pay the platform owner directly; the owner records the payment.

const { db, must, one } = require('../db');
const { HttpError, readJson } = require('../http');
const { requireAdmin, requireOwner } = require('../auth');
const { prices, currentPeriod, coverage, quote, payForLearners, credit } = require('../billing');

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

const routes = [
  // Balance, prices and who is paid for a term (default: the current term).
  ['GET', '/api/billing', async ({ req, query }) => {
    const admin = await requireAdmin(req);
    const { year, term } = parseChoice(query);
    const [school, learners, covered, ledger] = await Promise.all([
      db().from('schools').select('balance_cents').eq('id', admin.school_id).single().then(must),
      activeLearners(admin.school_id),
      coverage(admin.school_id, year),
      db().from('account_ledger').select('change_cents, balance_after_cents, kind, reason, created_at')
        .eq('school_id', admin.school_id).order('id', { ascending: false }).limit(30).then(must),
    ]);
    const unpaid = learners.filter(l => !covered.get(l.id)?.has(term));
    const ids = unpaid.map(l => l.id);
    return {
      balance_cents: school.balance_cents,
      prices: prices(),
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
      ledger,
    };
  }],

  // What a payment would cost. Body: { learner_ids: [...] | 'unpaid', year, term, plan: 'term' | 'year' }
  ['POST', '/api/billing/quote', async ({ req }) => {
    const admin = await requireAdmin(req);
    const body = await readJson(req);
    const choice = parseChoice(body);
    const q = quote(await chosenLearners(admin.school_id, body), await coverage(admin.school_id, choice.year), choice);
    return { ...choice, learners: q.learners, total_cents: q.total_cents };
  }],

  // Pays from the balance. Same body as the quote.
  ['POST', '/api/billing/pay', async ({ req }) => {
    const admin = await requireAdmin(req);
    const body = await readJson(req);
    const choice = parseChoice(body);
    const paid = await payForLearners(admin.school_id, await chosenLearners(admin.school_id, body), choice, admin.email);
    return { ...choice, learners: paid.learners, charged_cents: paid.total_cents, balance_cents: paid.balance_cents };
  }],

  // Owner: every school with its balance and learners paid for the current term.
  ['GET', '/api/owner/schools', async ({ req }) => {
    await requireOwner(req);
    const now = currentPeriod();
    const [schools, learners, paid] = await Promise.all([
      db().from('schools').select('id, name, county, phone, email, balance_cents, created_at').order('created_at', { ascending: false }).then(must),
      db().from('learners').select('school_id').eq('active', true).then(must),
      db().from('learner_terms').select('school_id').eq('year', now.year).eq('term', now.term).then(must),
    ]);
    const count = (rows, id) => rows.filter(r => r.school_id === id).length;
    return schools.map(s => ({ ...s, learners: count(learners, s.id), learners_paid_this_term: count(paid, s.id), period: now }));
  }],

  // Owner: credit a school after it pays (M-Pesa to you, bank, cash), or correct with a negative amount.
  ['POST', '/api/owner/schools/:id/balance', async ({ req, params }) => {
    const owner = await requireOwner(req);
    const body = await readJson(req);
    const cents = Math.round(Number(body.amount_kes) * 100);
    if (!Number.isFinite(cents) || cents === 0) throw new HttpError(400, 'Enter an amount in KES (not 0)');
    if (Math.abs(cents) > 10_000_000 * 100) throw new HttpError(400, 'That amount is too large');
    one(await db().from('schools').select('id').eq('id', params.id).maybeSingle(), 'School');
    const kind = cents > 0 ? 'payment' : 'adjustment';
    const balance = await credit(params.id, cents, kind, String(body.reason || (cents > 0 ? 'Payment received' : 'Correction')).slice(0, 200), owner.email);
    return { balance_cents: balance };
  }],
];

module.exports = { routes };
