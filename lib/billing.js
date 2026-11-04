// Pricing and payments.
//
// A learner is paid for one term at a time:
//  - per term: KES 20 per learner (LEARNER_TERM_FEE_KES)
//  - per year: KES 50 per learner (LEARNER_FEE_KES), covering all three terms
// Paying for the year after some terms are already paid only charges for what is
// left, and never more than the year price: min(year price, term price × terms left).
//
// There is no prepaid balance. The admin chooses learners (one, some or all unpaid) and
// a plan, sends the amount by M-Pesa (Paybill MPESA_PAYBILL, account = the school's
// account code), and types the M-Pesa confirmation code. The learners are unlocked at
// once; the payment shows as "awaiting check" until the platform owner confirms it.
// If the owner rejects it (no such M-Pesa payment), the learners are locked again.
// Amounts are in cents to avoid rounding errors.

const { db, must } = require('./db');
const { HttpError } = require('./http');

const TERMS = [1, 2, 3];

const prices = () => ({
  term_cents: Math.round(Number(process.env.LEARNER_TERM_FEE_KES || 20) * 100),
  year_cents: Math.round(Number(process.env.LEARNER_FEE_KES || 50) * 100),
});

const kes = cents => `KES ${(cents / 100).toLocaleString('en-KE', { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;

// Where schools send money. The account code tells the owner which school paid.
const accountCode = schoolId => `TM${String(schoolId).replace(/-/g, '').slice(0, 6).toUpperCase()}`;
const payTo = schoolId => ({ paybill: process.env.MPESA_PAYBILL || null, account: accountCode(schoolId) });

// M-Pesa confirmation codes are 10 letters and digits, e.g. QJK2X7AB9C.
function mpesaCode(v) {
  const code = String(v || '').trim().toUpperCase().replace(/\s+/g, '');
  if (!/^[A-Z0-9]{10}$/.test(code)) throw new HttpError(400, 'Type the 10-character M-Pesa code from the confirmation SMS, e.g. QJK2X7AB9C');
  return code;
}

// Kenyan school terms: roughly January–April, May–August, September–December.
function currentPeriod(date = new Date()) {
  const m = date.getMonth();
  return { year: date.getFullYear(), term: m <= 3 ? 1 : m <= 7 ? 2 : 3 };
}

/**
 * Pure: what paying would cost.
 * @param {string[]} learnerIds
 * @param {Map<string, Set<number>>} covered  learner → terms of the year already paid
 * @param {{ term: number, plan: 'term'|'year' }} choice
 * @returns {{ items: Array<{learner_id, terms: number[], cents}>, total_cents, learners }}
 */
function quote(learnerIds, covered, { term, plan }, p = prices()) {
  const items = [];
  for (const id of new Set(learnerIds)) {
    const have = covered.get(id) || new Set();
    const terms = plan === 'year' ? TERMS.filter(t => !have.has(t)) : have.has(term) ? [] : [term];
    if (!terms.length) continue;
    const cents = plan === 'year' ? Math.min(p.year_cents, p.term_cents * terms.length) : p.term_cents;
    items.push({ learner_id: id, terms, cents });
  }
  return { items, total_cents: items.reduce((n, i) => n + i.cents, 0), learners: items.length };
}

// learner → terms of `year` already paid for (payments awaiting check count; rejected ones are removed).
async function coverage(schoolId, year) {
  const rows = must(await db().from('learner_terms').select('learner_id, term').eq('school_id', schoolId).eq('year', year));
  const out = new Map();
  for (const r of rows) {
    if (!out.has(r.learner_id)) out.set(r.learner_id, new Set());
    out.get(r.learner_id).add(r.term);
  }
  return out;
}

// Learners paid for a given term.
async function paidLearnerIds(schoolId, year, term) {
  const rows = must(await db().from('learner_terms').select('learner_id').eq('school_id', schoolId).eq('year', year).eq('term', term));
  return new Set(rows.map(r => r.learner_id));
}

/** Records an M-Pesa payment and unlocks the learners' terms. Returns the payment. */
async function payForLearners(schoolId, learnerIds, { year, term, plan }, code, by) {
  if (!['term', 'year'].includes(plan)) throw new HttpError(400, 'Choose to pay per term or for the whole year');
  const mpesa = mpesaCode(code);
  const q = quote(learnerIds, await coverage(schoolId, year), { term, plan });
  if (!q.learners) throw new HttpError(400, 'These learners are already paid for');
  const used = must(await db().from('payments').select('id').eq('mpesa_code', mpesa).maybeSingle());
  if (used) throw new HttpError(409, `M-Pesa code ${mpesa} has already been used for a payment`);
  const n = q.learners;
  const payment = must(await db().from('payments').insert({
    school_id: schoolId, year, term, plan, learners: n, amount_cents: q.total_cents, mpesa_code: mpesa, status: 'pending',
    description: `${plan === 'year' ? `${year}` : `Term ${term} ${year}`} for ${n} learner${n === 1 ? '' : 's'}`,
    created_by: by || null,
  }).select().single());
  const { error } = await db().from('learner_terms').insert(q.items.flatMap(i => i.terms.map(t => ({
    learner_id: i.learner_id, school_id: schoolId, year, term: t, plan, fee_cents: Math.round(i.cents / i.terms.length), payment_id: payment.id,
  }))));
  if (error) {
    // Someone paid for the same learners at the same moment: undo, so nothing is paid twice.
    await db().from('payments').delete().eq('id', payment.id);
    throw new HttpError(409, 'Some of these learners were paid for just now; please refresh and try again');
  }
  return payment;
}

/** Owner: confirm (money received) or reject (no such payment: learners are locked again). */
async function checkPayment(id, ok, by, note) {
  const payment = must(await db().from('payments').select('*').eq('id', id).maybeSingle());
  if (!payment) throw new HttpError(404, 'Payment not found');
  if (payment.status === 'rejected') throw new HttpError(400, 'This payment was already rejected');
  if (!ok) must(await db().from('learner_terms').delete().eq('payment_id', id));
  return must(await db().from('payments').update({
    status: ok ? 'confirmed' : 'rejected', checked_by: by || null, checked_at: new Date().toISOString(),
    note: note ? String(note).slice(0, 200) : null,
  }).eq('id', id).select().single());
}

module.exports = { TERMS, prices, kes, payTo, accountCode, mpesaCode, currentPeriod, quote, coverage, paidLearnerIds, payForLearners, checkPayment };
