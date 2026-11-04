// Pricing and the school account balance.
//
// KES 50 per learner per school year (LEARNER_FEE_KES), paid from the school's prepaid
// balance when a new learner is added, and again for each learner when the school
// renews for a new year. In Phase 1 schools pay the platform owner directly and the
// owner adds the credit. Amounts are in cents to avoid rounding errors.

const { db, must } = require('./db');
const { HttpError } = require('./http');

const learnerFeeCents = () => Math.round(Number(process.env.LEARNER_FEE_KES || 50) * 100);
const kes = cents => `KES ${(cents / 100).toLocaleString('en-KE', { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
const currentYear = () => new Date().getFullYear();

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

async function paidLearnerIds(schoolId, year) {
  const rows = must(await db().from('learner_years').select('learner_id').eq('school_id', schoolId).eq('year', year));
  return new Set(rows.map(r => r.learner_id));
}

// Charges the yearly fee for learners not yet paid for in `year`, then records them as paid.
async function payForLearners(schoolId, learnerIds, year, by, reason) {
  const paid = await paidLearnerIds(schoolId, year);
  const due = [...new Set(learnerIds)].filter(id => !paid.has(id));
  if (!due.length) return { charged_cents: 0, learners: 0 };
  const fee = learnerFeeCents();
  const balance = await charge(schoolId, due.length * fee, 'learner_fee',
    reason || `${year} fee for ${due.length} learner${due.length === 1 ? '' : 's'}`, by, `Paying for ${due.length} learner${due.length === 1 ? '' : 's'}`);
  must(await db().from('learner_years').insert(due.map(learner_id => ({ learner_id, school_id: schoolId, year, fee_cents: fee }))));
  return { charged_cents: due.length * fee, learners: due.length, balance_cents: balance };
}

module.exports = { learnerFeeCents, kes, currentYear, charge, credit, balanceOf, paidLearnerIds, payForLearners };
