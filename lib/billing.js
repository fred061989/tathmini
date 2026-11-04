// Pricing and the school account balance.
//
// A learner is paid for one term at a time:
//  - per term: KES 20 per learner (LEARNER_TERM_FEE_KES)
//  - per year: KES 50 per learner (LEARNER_FEE_KES), covering all three terms
// Paying for the year after some terms are already paid only charges for what is
// left, and never more than the year price: min(year price, term price × terms left).
// Adding a learner does not charge anything; the admin then chooses to pay for that
// learner (or all unpaid learners) by the term or the year, from the prepaid balance.
// In Phase 1 schools pay the platform owner directly and the owner adds the credit.
// Amounts are in cents to avoid rounding errors.

const { db, must } = require('./db');
const { HttpError } = require('./http');

const TERMS = [1, 2, 3];

const prices = () => ({
  term_cents: Math.round(Number(process.env.LEARNER_TERM_FEE_KES || 20) * 100),
  year_cents: Math.round(Number(process.env.LEARNER_FEE_KES || 50) * 100),
});

const kes = cents => `KES ${(cents / 100).toLocaleString('en-KE', { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;

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

async function ledger(schoolId, change, balance, kind, reason, by) {
  must(await db().from('account_ledger').insert({ school_id: schoolId, change_cents: change, balance_after_cents: balance, kind, reason, created_by: by || null }));
}

async function balanceOf(schoolId) {
  return must(await db().from('schools').select('balance_cents').eq('id', schoolId).single()).balance_cents;
}

// Takes money atomically; 402 with a clear message if the balance does not cover it.
async function charge(schoolId, cents, kind, reason, by, what) {
  if (!cents) return balanceOf(schoolId);
  const { data, error } = await db().rpc('consume_balance', { p_school: schoolId, p_cents: cents });
  if (error) throw new Error(`Could not charge the account: ${error.message}`);
  if (data == null) {
    const have = await balanceOf(schoolId);
    throw new HttpError(402, `${what || reason} costs ${kes(cents)}, but the account balance is ${kes(have)}. Please top up to continue.`,
      { needed_cents: cents, balance_cents: have });
  }
  await ledger(schoolId, -cents, data, kind, reason, by);
  return data;
}

// Adds (or, negative, removes) money: owner credit, corrections and refunds.
async function credit(schoolId, cents, kind, reason, by) {
  const { data, error } = await db().rpc('add_balance', { p_school: schoolId, p_cents: cents });
  if (error) throw new Error(`Could not update the account: ${error.message}`);
  await ledger(schoolId, cents, data, kind, reason, by);
  return data;
}

// learner → terms of `year` already paid for.
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

/** Charges the balance and records the terms paid. Returns the quote that was paid. */
async function payForLearners(schoolId, learnerIds, { year, term, plan }, by) {
  if (!['term', 'year'].includes(plan)) throw new HttpError(400, 'Choose to pay per term or for the whole year');
  const q = quote(learnerIds, await coverage(schoolId, year), { term, plan });
  if (!q.learners) return { ...q, balance_cents: await balanceOf(schoolId) };
  const n = q.learners;
  const what = plan === 'year' ? `${year}` : `Term ${term} ${year}`;
  const balance = await charge(schoolId, q.total_cents, 'learner_fee', `${what} for ${n} learner${n === 1 ? '' : 's'}`, by,
    `Paying for ${n} learner${n === 1 ? '' : 's'} (${what})`);
  must(await db().from('learner_terms').insert(q.items.flatMap(i => i.terms.map(t => ({
    learner_id: i.learner_id, school_id: schoolId, year, term: t, plan, fee_cents: Math.round(i.cents / i.terms.length),
  })))));
  return { ...q, balance_cents: balance };
}

module.exports = { TERMS, prices, kes, currentPeriod, quote, charge, credit, balanceOf, coverage, paidLearnerIds, payForLearners };
