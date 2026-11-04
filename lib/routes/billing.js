// School billing (Phase 1): account balance, learners paid for, yearly renewal, account activity.
// Schools pay the platform owner directly; the owner adds credit (routes/owner.js).

const { db, must } = require('../db');
const { HttpError, readJson } = require('../http');
const { requireAdmin, requireOwner } = require('../auth');
const { learnerFeeCents, currentYear, payForLearners, paidLearnerIds, credit } = require('../billing');
const { one } = require('../db');

const routes = [
  ['GET', '/api/billing', async ({ req }) => {
    const admin = await requireAdmin(req);
    const year = currentYear();
    const [school, learners, paidNow, paidNext, ledger] = await Promise.all([
      db().from('schools').select('balance_cents').eq('id', admin.school_id).single().then(must),
      db().from('learners').select('id').eq('school_id', admin.school_id).eq('active', true).then(must),
      paidLearnerIds(admin.school_id, year),
      paidLearnerIds(admin.school_id, year + 1),
      db().from('account_ledger').select('change_cents, balance_after_cents, kind, reason, created_at')
        .eq('school_id', admin.school_id).order('id', { ascending: false }).limit(30).then(must),
    ]);
    const ids = learners.map(l => l.id);
    return {
      balance_cents: school.balance_cents,
      learner_fee_cents: learnerFeeCents(),
      year,
      learners: ids.length,
      learners_paid: ids.filter(id => paidNow.has(id)).length,
      learners_unpaid: ids.filter(id => !paidNow.has(id)).length,
      next_year: { year: year + 1, learners_paid: ids.filter(id => paidNext.has(id)).length },
      ledger,
    };
  }],

  // Pays the yearly fee for every active learner not yet paid for. Body: { year } (this year or next).
  ['POST', '/api/billing/renew', async ({ req }) => {
    const admin = await requireAdmin(req);
    const year = Number((await readJson(req)).year || currentYear());
    if (![currentYear(), currentYear() + 1].includes(year)) throw new HttpError(400, 'You can renew for this year or next year');
    const learners = must(await db().from('learners').select('id').eq('school_id', admin.school_id).eq('active', true));
    return payForLearners(admin.school_id, learners.map(l => l.id), year, admin.email, `${year} renewal`);
  }],

  // Owner: every school with its balance and learners paid for this year.
  ['GET', '/api/owner/schools', async ({ req }) => {
    await requireOwner(req);
    const [schools, learners, paid] = await Promise.all([
      db().from('schools').select('id, name, county, phone, email, balance_cents, created_at').order('created_at', { ascending: false }).then(must),
      db().from('learners').select('school_id').eq('active', true).then(must),
      db().from('learner_years').select('school_id').eq('year', currentYear()).then(must),
    ]);
    const count = (rows, id) => rows.filter(r => r.school_id === id).length;
    return schools.map(s => ({ ...s, learners: count(learners, s.id), learners_paid_this_year: count(paid, s.id) }));
  }],

  // Owner: credit a school after it pays (M-Pesa to you, bank, cash), or correct with a negative amount.
  // Body: { amount_kes, reason }
  ['POST', '/api/owner/schools/:id/balance', async ({ req, params }) => {
    const owner = await requireOwner(req);
    const body = await readJson(req);
    const cents = Math.round(Number(body.amount_kes) * 100);
    if (!Number.isFinite(cents) || cents === 0) throw new HttpError(400, 'Enter an amount in KES (not 0)');
    one(await db().from('schools').select('id').eq('id', params.id).maybeSingle(), 'School');
    const kind = cents > 0 ? 'payment' : 'adjustment';
    const balance = await credit(params.id, cents, kind, String(body.reason || (cents > 0 ? 'Payment received' : 'Correction')).slice(0, 200), owner.email);
    return { balance_cents: balance };
  }],
];

module.exports = { routes };
