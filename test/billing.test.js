const test = require('node:test');
const assert = require('node:assert/strict');
const { quote, currentPeriod } = require('../lib/billing');

const p = { term_cents: 2000, year_cents: 5000 };
const covered = new Map([['paidT1', new Set([1])], ['paidAll', new Set([1, 2, 3])], ['paidT1T2', new Set([1, 2])]]);

test('per term: KES 20 for each learner not yet paid for that term', () => {
  const q = quote(['new', 'paidT1', 'paidAll'], covered, { term: 1, plan: 'term' }, p);
  assert.deepEqual([q.learners, q.total_cents], [1, 2000]);
  assert.deepEqual(quote(['paidT1'], covered, { term: 2, plan: 'term' }, p).total_cents, 2000);
});

test('per year: KES 50, or less when some terms are already paid', () => {
  assert.equal(quote(['new'], covered, { term: 1, plan: 'year' }, p).total_cents, 5000);
  // Term 1 paid at KES 20; the rest of the year is 2 × 20 = 40, cheaper than 50
  assert.deepEqual(quote(['paidT1'], covered, { term: 2, plan: 'year' }, p).items, [{ learner_id: 'paidT1', terms: [2, 3], cents: 4000 }]);
  assert.equal(quote(['paidT1T2'], covered, { term: 3, plan: 'year' }, p).total_cents, 2000);
  assert.equal(quote(['paidAll'], covered, { term: 1, plan: 'year' }, p).learners, 0);
  // Never more than 50 for a whole year, however it is paid
  assert.equal(quote(['new', 'new'], covered, { term: 1, plan: 'year' }, p).total_cents, 5000);
});

test('school terms by month', () => {
  assert.deepEqual(currentPeriod(new Date(2027, 0, 10)), { year: 2027, term: 1 });
  assert.deepEqual(currentPeriod(new Date(2027, 5, 1)), { year: 2027, term: 2 });
  assert.deepEqual(currentPeriod(new Date(2027, 9, 1)), { year: 2027, term: 3 });
});
