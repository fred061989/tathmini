// End-to-end Phase 1 flow against an in-memory database and a stubbed Google Sheets.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFake } = require('./helpers/fake-supabase');
const { call } = require('./helpers/call');

const fake = createFake();
const supabasePath = require.resolve('@supabase/supabase-js');
require.cache[supabasePath] = { id: supabasePath, filename: supabasePath, loaded: true, exports: { createClient: () => fake } };
process.env.STATE_SECRET = 'test-secret';
process.env.PLATFORM_OWNER_EMAILS = 'owner@tathmini.co.ke';
process.env.LEARNER_FEE_KES = '50';
process.env.LEARNER_TERM_FEE_KES = '20';

const sheets = require('../lib/sheets');
const api = require('../api/index');

const created = [];
let sheetValues = null;
sheets.createAssessmentSheet = async (token, args) => {
  created.push(args);
  return { spreadsheetId: `sheet-${created.length}`, url: `https://docs.google.com/spreadsheets/d/sheet-${created.length}/edit` };
};
sheets.readAssessmentSheet = async () => sheetValues;

fake.users.set('admin', { id: 'u-admin', email: 'head@kilimani.sc.ke' });
fake.users.set('ict', { id: 'u-ict', email: 'ict@kilimani.sc.ke' });
fake.users.set('teacher', { id: 'u-teacher', email: 'wanjiku@kilimani.sc.ke' });
fake.users.set('owner', { id: 'u-owner', email: 'owner@tathmini.co.ke' });

const as = token => (method, url, body) => call(api, method, url, body, { authorization: `Bearer ${token}` });
const admin = as('admin');
const owner = as('owner');
const ok = r => { assert.ok(r.status < 300, `${r.status} ${JSON.stringify(r.body)}`); return r.body; };
const YEAR = new Date().getFullYear();
const NOW_TERM = (m => (m <= 3 ? 1 : m <= 7 ? 2 : 3))(new Date().getMonth());

// Fills the most recently created sheet: { 'Learner Name': [scores...] | 'absent' } plus optional comments.
function fill(scoresByName, comments = {}) {
  const layout = sheets.buildSheetLayout(created[created.length - 1]);
  return [layout.header, ...layout.rows.map(r => {
    const s = scoresByName[r[2]];
    if (s === 'absent') return [...r.slice(0, layout.scoreEnd), 'Y', ''];
    if (!s) return r;
    return [...r.slice(0, layout.scoreStart), ...s, '', comments[r[2]] || ''];
  })];
}

test('Phase 1 flow', async (t) => {
  const ids = {};

  await t.test('sign-in rules', async () => {
    assert.equal((await call(api, 'GET', '/api/me', null, {})).status, 401);
    assert.equal((await as('teacher')('GET', '/api/classes')).status, 403);
  });

  await t.test('owner loads the national curriculum', async () => {
    assert.equal((await admin('POST', '/api/curriculum/import', { starter: true })).status, 403);
    const out = ok(await owner('POST', '/api/curriculum/import', { starter: true }));
    assert.equal(out.areas_added, 20);
    const g7 = ok(await owner('GET', '/api/curriculum?grade=7'));
    const maths = g7.find(a => a.name === 'Mathematics');
    assert.equal(maths.strands[0].name, 'Numbers');
    assert.ok(maths.strands[0].sub_strands.some(s => s.name === 'Fractions'));
    assert.ok(!g7.some(a => a.name === 'Science and Technology'));
  });

  await t.test('admin registers the school and adds the ICT person as admin', async () => {
    const out = ok(await admin('POST', '/api/schools', { name: 'Kilimani Junior School', short_name: 'Kilimani JS', full_name: 'Peter Kamau' }));
    assert.equal(out.staff.role, 'admin');
    ok(await admin('PATCH', '/api/school', { county: 'Nairobi', motto: 'Excellence through effort', head_teacher_name: 'Mr P. Kamau' }));
    assert.equal((await admin('PATCH', '/api/school', { grading: { cbc4: { ME: 90 } } })).status, 400);
    ok(await admin('POST', '/api/staff', { full_name: 'ICT Officer', email: 'ict@kilimani.sc.ke', role: 'admin' }));
    assert.equal(ok(await as('ict')('GET', '/api/me')).staff.role, 'admin');
    fake.store.schools[0].google_refresh_token = 'refresh-token';
    const areas = ok(await admin('GET', '/api/curriculum'));
    ids.math = areas.find(a => a.name === 'Mathematics').id;
    ids.eng = areas.find(a => a.name === 'English').id;
    ids.sct = areas.find(a => a.name === 'Science and Technology').id;
  });

  await t.test('learners are added free, then paid for by the term (KES 20) or the year (KES 50)', async () => {
    ids.teacher = ok(await admin('POST', '/api/staff', { full_name: 'Janet Wanjiku', email: 'wanjiku@kilimani.sc.ke' })).staff.id;
    ids.cls = ok(await admin('POST', '/api/classes', { grade: 7, stream: 'East', year: YEAR, class_teacher_id: ids.teacher })).id;
    const list = [
      { adm_no: '101', assessment_no: 'A101', first_name: 'Amani', last_name: 'Otieno', gender: 'f', parent_phone: '0712 345 678' },
      { adm_no: '102', first_name: 'Baraka', last_name: 'Kamau', gender: 'M' },
      { adm_no: '103', first_name: 'Chebet', last_name: 'Kiprop', gender: 'F' },
    ];
    const saved = ok(await admin('POST', '/api/learners', { class_id: ids.cls, learners: list }));
    assert.equal(saved.added, 3);
    assert.equal(saved.added_ids.length, 3);
    assert.equal(saved.learners[0].parent_phone, '+254712345678');
    const again = ok(await admin('POST', '/api/learners', { class_id: ids.cls, learners: [{ adm_no: '103', first_name: 'Chebet', last_name: 'Kiprop', parent_name: 'Mama Chebet' }] }));
    assert.equal(again.added, 0);

    let billing = ok(await admin('GET', `/api/billing?year=${YEAR}&term=1`));
    assert.deepEqual([billing.unpaid.length, billing.quotes.term, billing.quotes.year], [3, 6000, 15000]);

    // Not enough balance: nothing is paid
    const short = await admin('POST', '/api/billing/pay', { learner_ids: 'unpaid', year: YEAR, term: 1, plan: 'year' });
    assert.equal(short.status, 402);
    assert.match(short.body.error, /Paying for 3 learners \(\d+\) costs KES 150, but the account balance is KES 0/);
    assert.equal(ok(await owner('POST', `/api/owner/schools/${fake.store.schools[0].id}/balance`, { amount_kes: 500, reason: 'M-Pesa QJK2X7' })).balance_cents, 50000);

    // Two learners for the whole year, one (joined mid-term) for just Term 1
    const [amani, baraka, chebet] = saved.added_ids;
    const q = ok(await admin('POST', '/api/billing/quote', { learner_ids: [amani, baraka], year: YEAR, term: 1, plan: 'year' }));
    assert.deepEqual([q.learners, q.total_cents], [2, 10000]);
    const yearPay = ok(await admin('POST', '/api/billing/pay', { learner_ids: [amani, baraka], year: YEAR, term: 1, plan: 'year' }));
    assert.deepEqual([yearPay.charged_cents, yearPay.balance_cents], [10000, 40000]);
    const termPay = ok(await admin('POST', '/api/billing/pay', { learner_ids: [chebet], year: YEAR, term: 1, plan: 'term' }));
    assert.equal(termPay.charged_cents, 2000);
    // Paying again changes nothing; Chebet's rest of the year costs 2 × 20 = 40, not 50
    assert.equal(ok(await admin('POST', '/api/billing/pay', { learner_ids: 'unpaid', year: YEAR, term: 1, plan: 'year' })).charged_cents, 4000);
    assert.equal(ok(await admin('GET', `/api/billing?year=${YEAR}&term=3`)).unpaid.length, 0);
    // Someone else's learner cannot be paid for through this school
    assert.equal((await admin('POST', '/api/billing/quote', { learner_ids: ['not-mine'], year: YEAR, term: 1, plan: 'term' })).status, 400);

    billing = ok(await admin('GET', `/api/billing?year=${YEAR}&term=1`));
    assert.deepEqual([billing.balance_cents, billing.paid, billing.prices.term_cents, billing.prices.year_cents], [34000, 3, 2000, 5000]);
    assert.deepEqual(billing.ledger.map(l => l.kind), ['learner_fee', 'learner_fee', 'learner_fee', 'payment']);
  });

  await t.test('teachers are assigned learning areas taught in the grade', async () => {
    ids.asgMath = ok(await admin('POST', '/api/assignments', { teacher_id: ids.teacher, class_id: ids.cls, learning_area_id: ids.math })).id;
    ids.asgEng = ok(await admin('POST', '/api/assignments', { teacher_id: ids.teacher, class_id: ids.cls, learning_area_id: ids.eng })).id;
    const wrong = await admin('POST', '/api/assignments', { teacher_id: ids.teacher, class_id: ids.cls, learning_area_id: ids.sct });
    assert.equal(wrong.status, 400);
    assert.equal((await as('teacher')('GET', '/api/assessments')).status, 403);
  });

  await t.test('monthly assessment: per strand for Maths, total for English; sheets go to the teacher', async () => {
    const strands = ok(await admin('GET', '/api/curriculum?grade=7')).find(a => a.id === ids.math).strands;
    const bulk = await admin('POST', '/api/assessments', { assignment_ids: [ids.asgMath, ids.asgEng], kind: 'monthly', term: 1, year: YEAR, per_strand: true, components: [{ label: 'x', max_score: 5 }] });
    assert.equal(bulk.status, 400);
    const m = ok(await admin('POST', '/api/assessments', {
      assignment_ids: [ids.asgMath], kind: 'monthly', term: 1, year: YEAR, assessed_on: `${YEAR}-02-10`, per_strand: true,
      components: ['Numbers', 'Geometry'].map((n, i) => ({ label: n, strand_id: strands.find(s => s.name === n).id, max_score: i ? 10 : 20 })),
    })).created[0];
    assert.equal(m.assessment.status, 'sheet_ready');
    assert.equal(m.assessment.title, `Grade 7 East Mathematics - Monthly Term 1 ${YEAR}`);
    assert.equal(created[0].shareWith, 'wanjiku@kilimani.sc.ke');
    assert.equal(created[0].learners.length, 3);
    ids.m1 = m.assessment.id;

    sheetValues = fill({ 'Amani Otieno': [18, 9], 'Baraka Kamau': [8, ''] });
    const p = ok(await admin('GET', `/api/assessments/${ids.m1}/progress`));
    assert.deepEqual([p.entered, p.partial, p.total], [1, 1, 3]);

    sheetValues = fill({ 'Amani Otieno': [18, 9], 'Baraka Kamau': [25, 2], 'Chebet Kiprop': 'absent' });
    const bad = await admin('POST', `/api/assessments/${ids.m1}/analyse`, {});
    assert.equal(bad.status, 422);
    assert.match(bad.body.details[0], /Baraka Kamau/);

    sheetValues = fill({ 'Amani Otieno': [18, 9], 'Baraka Kamau': [8, 1], 'Chebet Kiprop': 'absent' }, { 'Amani Otieno': 'Excellent work in numbers.' });
    const out = ok(await admin('POST', `/api/assessments/${ids.m1}/analyse`, {}));
    assert.deepEqual([out.summary.assessed, out.summary.absent, out.summary.mean_percent], [2, 1, 60]);
    assert.equal(ok(await admin('GET', `/api/assessments/${ids.m1}`)).results.length, 3);

    const e = ok(await admin('POST', '/api/assessments', { assignment_ids: [ids.asgEng], kind: 'monthly', term: 1, year: YEAR, assessed_on: `${YEAR}-02-11`, max_score: 50 })).created[0];
    sheetValues = fill({ 'Amani Otieno': [30], 'Baraka Kamau': [40], 'Chebet Kiprop': [45] }, { 'Chebet Kiprop': 'Reads fluently.' });
    ok(await admin('POST', `/api/assessments/${e.assessment.id}/analyse`, {}));
  });

  await t.test('end-term assessment for both learning areas at once', async () => {
    const both = ok(await admin('POST', '/api/assessments', { assignment_ids: [ids.asgMath, ids.asgEng], kind: 'end_term', term: 1, year: YEAR, assessed_on: `${YEAR}-03-28`, max_score: 100 })).created;
    assert.equal(both.length, 2);
    const mathEnd = both.find(c => c.assessment.learning_area_id === ids.math).assessment;
    const engEnd = both.find(c => c.assessment.learning_area_id === ids.eng).assessment;
    const layoutFor = id => created.find((c, i) => `sheet-${i + 1}` === fake.store.assessments.find(a => a.id === id).sheet_id);
    for (const [a, marks] of [[mathEnd, { 'Amani Otieno': 80, 'Baraka Kamau': 50, 'Chebet Kiprop': 70 }], [engEnd, { 'Amani Otieno': 50, 'Baraka Kamau': 90, 'Chebet Kiprop': 85 }]]) {
      const layout = sheets.buildSheetLayout(layoutFor(a.id));
      sheetValues = [layout.header, ...layout.rows.map(r => [...r.slice(0, 3), marks[r[2]], '', ''])];
      ok(await admin('POST', `/api/assessments/${a.id}/analyse`, {}));
    }
  });

  await t.test("class teacher's sheet: term averages per learning area with class means", async () => {
    const s = ok(await admin('GET', `/api/classes/${ids.cls}/term?year=${YEAR}&term=1`));
    assert.equal(s.class.label, 'Grade 7 East');
    assert.equal(s.class.class_teacher, 'Janet Wanjiku');
    assert.deepEqual(s.columns.map(c => c.label), ['Monthly', 'End-term']);
    const amani = s.learners.find(l => l.name === 'Amani Otieno');
    assert.equal(amani.areas[ids.math].average, 85);   // monthly 90, end-term 80
    assert.equal(amani.areas[ids.eng].average, 55);    // monthly 60, end-term 50
    assert.equal(amani.overall_percent, 70);
    const chebet = s.learners.find(l => l.name === 'Chebet Kiprop');
    assert.deepEqual(chebet.areas[ids.math].cells.monthly, { absent: true });
    assert.equal(chebet.areas[ids.math].average, 70);  // absence left out
    assert.ok(s.areas.find(a => a.id === ids.math).mean_percent != null);
  });

  await t.test('termly report forms: comments drafted, editable, then locked when the term closes', async () => {
    const r = ok(await admin('GET', `/api/reports/termly?class_id=${ids.cls}&year=${YEAR}&term=1`));
    assert.equal(r.reports.length, 3);
    assert.equal(r.school.motto, 'Excellence through effort');
    const amani = r.reports.find(x => x.name === 'Amani Otieno');
    assert.equal(amani.areas[ids.math].comment, 'Excellent work in numbers.');
    assert.equal(amani.areas[ids.math].teacher_initials, 'J.W.');
    assert.match(amani.class_comment, /^Amani has had a good term/);
    assert.equal(amani.comments_saved, false);
    assert.equal(r.reports.find(x => x.name === 'Chebet Kiprop').areas[ids.eng].comment, 'Reads fluently.');

    ok(await admin('PUT', '/api/report-comments', { learner_id: amani.learner_id, year: YEAR, term: 1, class_comment: 'Edited by the class teacher.', head_comment: 'Well done.', co_curricular: 'Athletics (county)' }));
    ok(await admin('PUT', '/api/terms', { year: YEAR, term: 1, closing_date: `${YEAR}-04-02`, next_term_date: `${YEAR}-04-26` }));
    const one = ok(await admin('GET', `/api/reports/termly?class_id=${ids.cls}&year=${YEAR}&term=1&learner_id=${amani.learner_id}`));
    assert.equal(one.reports.length, 1);
    assert.deepEqual([one.reports[0].class_comment, one.reports[0].head_comment, one.reports[0].co_curricular], ['Edited by the class teacher.', 'Well done.', 'Athletics (county)']);
    assert.equal(one.term_record.next_term_date, `${YEAR}-04-26`);

    ok(await admin('POST', '/api/terms/close', { year: YEAR, term: 1 }));
    assert.equal((await admin('POST', `/api/assessments/${ids.m1}/analyse`, {})).status, 400);
    assert.equal((await admin('PUT', '/api/report-comments', { learner_id: amani.learner_id, year: YEAR, term: 1, class_comment: 'x' })).status, 400);
    assert.equal((await admin('POST', '/api/assessments', { assignment_ids: [ids.asgEng], kind: 'weekly', term: 1, year: YEAR, max_score: 10 })).status, 400);
    assert.ok(ok(await admin('GET', `/api/reports/termly?class_id=${ids.cls}&year=${YEAR}&term=1`)).term_record.closed_at);
    ok(await admin('POST', '/api/terms/reopen', { year: YEAR, term: 1 }));
    assert.equal(ok(await admin('GET', `/api/reports/termly?class_id=${ids.cls}&year=${YEAR}&term=1`)).term_record.closed_at, null);
  });

  await t.test('a new year: learners are unpaid until paid for; owner sees all schools', async () => {
    const next = ok(await admin('GET', `/api/billing?year=${YEAR + 1}&term=1`));
    assert.deepEqual([next.unpaid.length, next.quotes.year], [3, 15000]);
    const asg = fake.store.teacher_assignments.find(a => a.class_id === ids.cls);
    const out = ok(await admin('POST', '/api/assessments', { assignment_ids: [asg.id], kind: 'weekly', year: YEAR + 1, term: 1, max_score: 10 }));
    assert.match(out.created[0].note, /no learners paid for Term 1/);
    const schools = ok(await owner('GET', '/api/owner/schools'));
    assert.deepEqual([schools[0].name, schools[0].learners, schools[0].balance_cents], ['Kilimani Junior School', 3, 34000]);
    assert.equal((await admin('GET', '/api/owner/schools')).status, 403);
  });
});
