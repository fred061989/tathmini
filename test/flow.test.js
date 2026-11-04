// End-to-end Phase 1 flow against an in-memory database and a stubbed Google Sheets.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFake } = require('./helpers/fake-supabase');
const { call } = require('./helpers/call');

const fake = createFake();
const supabasePath = require.resolve('@supabase/supabase-js');
require.cache[supabasePath] = { id: supabasePath, filename: supabasePath, loaded: true, exports: { createClient: () => fake } };
process.env.STATE_SECRET = 'test-secret-that-is-long-enough';
process.env.PLATFORM_OWNER_EMAILS = 'owner@tathmini.co.ke';
process.env.LEARNER_FEE_KES = '50';
process.env.LEARNER_TERM_FEE_KES = '20';

const sheets = require('../lib/sheets');
const api = require('../api/index');

// Stand-in for Google: records each workbook, and each tab (with its workbook's id and teacher) in `created`.
const created = [];
const workbooks = [];
let sheetValues = null;
const reads = [];
sheets.createWorkbook = async (token, args) => {
  workbooks.push(args);
  const id = `sheet-${workbooks.length}`;
  const titles = sheets.tabTitles(args.tabs.map(t => t.title));
  args.tabs.forEach((tab, i) => created.push({ ...tab, title: titles[i], spreadsheetId: id, shareWith: args.shareWith }));
  return { spreadsheetId: id, url: `https://docs.google.com/spreadsheets/d/${id}/edit`, tabs: titles.map((title, i) => ({ title, sheetId: 100 + i })) };
};
sheets.readAssessmentSheet = async (token, id, tab) => { reads.push({ id, tab }); return sheetValues; };
const appended = [];
sheets.addLearnersToSheet = async (token, id, args) => { appended.push({ id, ...args }); return { added: args.learners.length }; };

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
  return [...layout.top, ...layout.rows.map(r => {
    const s = scoresByName[r[2]];
    if (s === 'absent') return [...r.slice(0, layout.scoreStart), ...r.slice(layout.scoreStart, layout.scoreEnd).map(() => 'AB'), '', ''];
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

    // Paying needs the M-Pesa code; a wrong-looking code is refused and nothing is paid
    const bad = await admin('POST', '/api/billing/pay', { learner_ids: 'unpaid', year: YEAR, term: 1, plan: 'year', mpesa_code: '12' });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /10-character M-Pesa code/);
    assert.equal(billing.pay_to.account, `TM${fake.store.schools[0].id.replace(/-/g, '').slice(0, 6).toUpperCase()}`);

    // Two learners for the whole year, one (joined mid-term) for just Term 1
    const [amani, baraka, chebet] = saved.added_ids;
    const q = ok(await admin('POST', '/api/billing/quote', { learner_ids: [amani, baraka], year: YEAR, term: 1, plan: 'year' }));
    assert.deepEqual([q.learners, q.total_cents], [2, 10000]);
    const yearPay = ok(await admin('POST', '/api/billing/pay', { learner_ids: [amani, baraka], year: YEAR, term: 1, plan: 'year', mpesa_code: 'qjk2x7ab9c' }));
    assert.deepEqual([yearPay.amount_cents, yearPay.payment.mpesa_code, yearPay.payment.status], [10000, 'QJK2X7AB9C', 'pending']);
    // The same M-Pesa code cannot be used twice
    assert.equal((await admin('POST', '/api/billing/pay', { learner_ids: [chebet], year: YEAR, term: 1, plan: 'term', mpesa_code: 'QJK2X7AB9C' })).status, 409);
    const termPay = ok(await admin('POST', '/api/billing/pay', { learner_ids: [chebet], year: YEAR, term: 1, plan: 'term', mpesa_code: 'QJK2X7AB9D' }));
    assert.equal(termPay.amount_cents, 2000);
    // Already paid: nothing to pay
    assert.equal((await admin('POST', '/api/billing/pay', { learner_ids: [amani], year: YEAR, term: 1, plan: 'term', mpesa_code: 'QJK2X7AB9E' })).status, 400);
    // Chebet's rest of the year costs 2 × 20 = 40, not 50
    const rest = ok(await admin('POST', '/api/billing/pay', { learner_ids: 'unpaid', year: YEAR, term: 1, plan: 'year', mpesa_code: 'QJK2X7AB9F' }));
    assert.equal(rest.amount_cents, 4000);
    assert.equal(ok(await admin('GET', `/api/billing?year=${YEAR}&term=3`)).unpaid.length, 0);
    // Someone else's learner cannot be paid for through this school
    assert.equal((await admin('POST', '/api/billing/quote', { learner_ids: ['not-mine'], year: YEAR, term: 1, plan: 'term' })).status, 400);

    // The owner checks payments against the M-Pesa statement
    const waiting = ok(await owner('GET', '/api/owner/payments?status=pending'));
    assert.deepEqual(waiting.map(p => p.mpesa_code).sort(), ['QJK2X7AB9C', 'QJK2X7AB9D', 'QJK2X7AB9F']);
    assert.equal(waiting[0].schools.name, 'Kilimani Junior School');
    ok(await owner('POST', `/api/owner/payments/${yearPay.payment.id}/confirm`, {}));
    // A code with no M-Pesa payment behind it: rejecting it locks Chebet's terms again
    ok(await owner('POST', `/api/owner/payments/${rest.payment.id}/reject`, { note: 'Not on statement' }));
    billing = ok(await admin('GET', `/api/billing?year=${YEAR}&term=2`));
    assert.deepEqual(billing.unpaid.map(l => l.name), ['Chebet Kiprop']);
    assert.equal((await admin('POST', `/api/owner/payments/${termPay.payment.id}/confirm`, {})).status, 403);
    ok(await owner('POST', `/api/owner/payments/${termPay.payment.id}/confirm`, {}));

    billing = ok(await admin('GET', `/api/billing?year=${YEAR}&term=1`));
    assert.deepEqual([billing.paid, billing.prices.term_cents, billing.prices.year_cents], [3, 2000, 5000]);
    // (Payments made in the same millisecond have no fixed order, so compare them sorted.)
    assert.deepEqual(billing.payments.map(p => [p.description, p.status]).sort(),
      [[`${YEAR} for 1 learner`, 'rejected'], [`${YEAR} for 2 learners`, 'confirmed'], [`Term 1 ${YEAR} for 1 learner`, 'confirmed']]);
    assert.equal(billing.payments.find(p => p.status === 'rejected').note, 'Not on statement');
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
    // Same teacher for both: ONE workbook, ONE email, a tab for each learning area
    const wb = workbooks[workbooks.length - 1];
    assert.equal(ok(await admin('GET', '/api/assessments')).filter(a => a.sheet_id === mathEnd.sheet_id).length, 2);
    assert.equal(mathEnd.sheet_id, engEnd.sheet_id);
    assert.deepEqual(wb.tabs.map(t => t.title), ['Mathematics – Grade 7 East', 'English – Grade 7 East']);
    assert.match(wb.title, /^Kilimani JS - Janet Wanjiku - End-term Term 1 \d{4}$/);
    assert.match(wb.message, /these 2 learning areas.*Mathematics – Grade 7 East; English – Grade 7 East/);
    assert.equal(wb.shareWith, 'wanjiku@kilimani.sc.ke');
    assert.deepEqual([mathEnd.sheet_tab, engEnd.sheet_tab], ['Mathematics – Grade 7 East', 'English – Grade 7 East']);
    assert.match(engEnd.sheet_url, /#gid=101$/);
    const layoutFor = id => { const a = fake.store.assessments.find(x => x.id === id); return created.find(c => c.spreadsheetId === a.sheet_id && c.title === a.sheet_tab); };
    for (const [a, marks] of [[mathEnd, { 'Amani Otieno': 80, 'Baraka Kamau': 50, 'Chebet Kiprop': 70 }], [engEnd, { 'Amani Otieno': 50, 'Baraka Kamau': 90, 'Chebet Kiprop': 85 }]]) {
      const layout = sheets.buildSheetLayout(layoutFor(a.id));
      sheetValues = [...layout.top, ...layout.rows.map(r => [...r.slice(0, 3), marks[r[2]], "", ""])];
      ok(await admin('POST', `/api/assessments/${a.id}/analyse`, {}));
      assert.deepEqual(reads[reads.length - 1], { id: a.sheet_id, tab: a.sheet_tab }); // each assessment reads its own tab
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
    assert.equal(amani.areas[ids.math].remark, 'Very good work. Keep it up!'); // 85% = EE2
    assert.equal(amani.areas[ids.math].teacher_initials, 'J.W.');
    assert.match(amani.class_comment, /^Amani has had a good term/);
    assert.equal(amani.comments_saved, false);
    assert.equal(r.reports.find(x => x.name === 'Baraka Kamau').areas[ids.math].remark, 'Making progress. Keep practising.');

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

  await t.test('strand-by-strand schools: term results built from strand marks', async () => {
    assert.equal((await admin('PATCH', '/api/school', { assessment_style: 'average' })).status, 400);
    ok(await admin('PATCH', '/api/school', { assessment_style: 'strands' }));
    const r = ok(await admin('GET', `/api/reports/termly?class_id=${ids.cls}&year=${YEAR}&term=1`));
    assert.equal(r.style, 'strands');
    assert.deepEqual(r.columns, []);
    assert.deepEqual(r.areas.find(a => a.id === ids.math).strands, ['Numbers', 'Geometry']);
    const by = name => r.reports.find(x => x.name === name).areas[ids.math];
    // Amani: Numbers 18/20 = 90%, Geometry 9/10 = 90% → 27/30 = 90 (the end-term total is not needed: there are strand marks)
    assert.deepEqual(by('Amani Otieno').strands.map(s => [s.name, s.percent, s.level]), [['Numbers', 90, 'EE1'], ['Geometry', 90, 'EE1']]);
    assert.equal(by('Amani Otieno').average, 90);
    assert.equal(by('Baraka Kamau').average, 30);   // (8 + 1) / (20 + 10)
    assert.equal(by('Chebet Kiprop').average, 70);  // absent for the strand test: only the end-term total
    ok(await admin('PATCH', '/api/school', { assessment_style: 'exams' }));
  });

  await t.test('end of year: Term 1, 2 and 3 averages and the year average', async () => {
    // A Term 2 English test for Amani and Baraka
    const e2 = ok(await admin('POST', '/api/assessments', { assignment_ids: [ids.asgEng], kind: 'end_term', term: 2, year: YEAR, assessed_on: `${YEAR}-07-30`, max_score: 100 })).created[0].assessment;
    sheetValues = fill({ 'Amani Otieno': [75], 'Baraka Kamau': [60], 'Chebet Kiprop': 'absent' });
    ok(await admin('POST', `/api/assessments/${e2.id}/analyse`, {}));
    const y = ok(await admin('GET', `/api/classes/${ids.cls}/year?year=${YEAR}`));
    assert.deepEqual(y.terms, [1, 2, 3]);
    const amani = y.learners.find(l => l.name === 'Amani Otieno');
    assert.deepEqual(amani.areas[ids.eng].terms, { 1: 55, 2: 75 });
    assert.equal(amani.areas[ids.eng].average, 65);  // mean of the terms with results
    assert.deepEqual(amani.areas[ids.math].terms, { 1: 85 });
    assert.equal(amani.overall_percent, 75);
    assert.equal(y.learners.find(l => l.name === 'Chebet Kiprop').areas[ids.eng].terms[2], undefined);

    const rep = ok(await admin('GET', `/api/reports/annual?class_id=${ids.cls}&year=${YEAR}&learner_id=${amani.learner_id}`));
    assert.equal(rep.reports.length, 1);
    assert.match(rep.reports[0].class_comment, /^Amani has had an excellent year/);
    ok(await admin('PUT', '/api/report-comments', { learner_id: amani.learner_id, year: YEAR, term: 0, class_comment: 'A strong year.' }));
    assert.equal(ok(await admin('GET', `/api/reports/annual?class_id=${ids.cls}&year=${YEAR}`)).reports.find(x => x.learner_id === amani.learner_id).class_comment, 'A strong year.');
    // Term 1 comments are separate from the year's
    assert.equal(ok(await admin('GET', `/api/reports/termly?class_id=${ids.cls}&year=${YEAR}&term=1&learner_id=${amani.learner_id}`)).reports[0].class_comment, 'Edited by the class teacher.');
    // Closing Term 3 locks the year's comments
    ok(await admin('POST', '/api/terms/close', { year: YEAR, term: 3 }));
    assert.equal((await admin('PUT', '/api/report-comments', { learner_id: amani.learner_id, year: YEAR, term: 0, class_comment: 'x' })).status, 400);
    ok(await admin('POST', '/api/terms/reopen', { year: YEAR, term: 3 }));
    assert.equal((await admin('GET', `/api/classes/${ids.cls}/year?year=abc`)).status, 400);
  });

  await t.test('a new year: learners are unpaid until paid for; owner sees all schools', async () => {
    const next = ok(await admin('GET', `/api/billing?year=${YEAR + 1}&term=1`));
    assert.deepEqual([next.unpaid.length, next.quotes.year], [3, 15000]);
    const asg = fake.store.teacher_assignments.find(a => a.class_id === ids.cls);
    const out = ok(await admin('POST', '/api/assessments', { assignment_ids: [asg.id], kind: 'weekly', year: YEAR + 1, term: 1, max_score: 10 }));
    assert.match(out.created[0].note, /no learners paid for Term 1/);
    const schools = ok(await owner('GET', '/api/owner/schools'));
    assert.deepEqual([schools[0].name, schools[0].learners, schools[0].confirmed_cents, schools[0].pending_cents], ['Kilimani Junior School', 3, 12000, 0]);
    assert.equal((await admin('GET', '/api/owner/schools')).status, 403);
  });
});

test('managing learners: edit, move class, remove', async () => {
  const cls = fake.store.classes.find(c => c.grade === 7);
  const baraka = fake.store.learners.find(l => l.first_name === 'Baraka');
  const edited = ok(await admin('PATCH', `/api/learners/${baraka.id}`, { first_name: ' Baraka ', parent_phone: '0722 000 111', gender: 'male' }));
  assert.deepEqual([edited.first_name, edited.parent_phone, edited.gender], ['Baraka', '+254722000111', 'M']);
  assert.equal((await admin('PATCH', `/api/learners/${baraka.id}`, { parent_phone: '123' })).status, 400);
  assert.equal((await admin('PATCH', `/api/learners/${baraka.id}`, { last_name: '  ' })).status, 400);
  // Moving to a class that is not this school's is refused
  assert.equal((await admin('PATCH', `/api/learners/${baraka.id}`, { class_id: 'other-school-class' })).status, 404);
  const other = ok(await admin('POST', '/api/classes', { grade: 7, stream: 'West', year: cls.year }));
  ok(await admin('PATCH', `/api/learners/${baraka.id}`, { class_id: other.id }));
  assert.equal(ok(await admin('GET', `/api/learners?class_id=${other.id}`)).length, 1);
  ok(await admin('PATCH', `/api/learners/${baraka.id}`, { class_id: cls.id }));
  // Removing hides the learner from lists, but keeps their history
  const chebet = fake.store.learners.find(l => l.first_name === 'Chebet');
  ok(await admin('PATCH', `/api/learners/${chebet.id}`, { active: false }));
  assert.ok(!ok(await admin('GET', `/api/learners?class_id=${cls.id}`)).some(l => l.id === chebet.id));
  const reports = ok(await admin('GET', `/api/reports/termly?class_id=${cls.id}&year=${cls.year}&term=1`));
  assert.ok(reports.reports.some(r => r.learner_id === chebet.id), 'a learner who left still has their old report form');
});

test('promoting a class keeps old report forms; a final class can be marked completed', async () => {
  const cls = fake.store.classes.find(c => c.grade === 7 && c.stream === 'East');
  const before = ok(await admin('GET', `/api/reports/termly?class_id=${cls.id}&year=${cls.year}&term=1`)).reports.length;
  const out = ok(await admin('POST', `/api/classes/${cls.id}/promote`, { mode: 'promote' }));
  assert.equal(out.promoted, 2);
  assert.deepEqual([out.class.grade, out.class.stream, out.class.year], [8, 'East', cls.year + 1]);
  assert.equal(ok(await admin('GET', `/api/learners?class_id=${cls.id}`)).length, 0);
  assert.equal(ok(await admin('GET', `/api/learners?class_id=${out.class.id}`)).length, 2);
  assert.equal(ok(await admin('GET', `/api/reports/termly?class_id=${cls.id}&year=${cls.year}&term=1`)).reports.length, before);
  // Promoting the West stream reuses an existing next-year class rather than creating a duplicate
  const west = fake.store.classes.find(c => c.grade === 7 && c.stream === 'West');
  const amani = fake.store.learners.find(l => l.first_name === 'Amani');
  ok(await admin('PATCH', `/api/learners/${amani.id}`, { class_id: west.id }));
  const w = ok(await admin('POST', `/api/classes/${west.id}/promote`, { mode: 'promote' }));
  assert.equal(fake.store.classes.filter(c => c.grade === 8 && c.stream === 'West').length, 1);
  assert.equal((await admin('POST', `/api/classes/${west.id}/promote`, { mode: 'promote' })).status, 400); // now empty
  const done = ok(await admin('POST', `/api/classes/${w.class.id}/promote`, { mode: 'complete' }));
  assert.equal(done.completed, 1);
  assert.equal(fake.store.learners.find(l => l.id === amani.id).active, false);
  assert.equal((await admin('POST', `/api/classes/${w.class.id}/promote`, { mode: 'x' })).status, 400);
});

test('managing teachers: edit, remove, and reassign their learning areas', async () => {
  const t = ok(await admin('POST', '/api/staff', { full_name: 'Tom Leaver', email: 'tom@gmail.com' })).staff;
  const cls = ok(await admin('POST', '/api/classes', { grade: 7, stream: 'North', year: new Date().getFullYear() }));
  const maths = ok(await admin('GET', '/api/curriculum')).find(a => a.name === 'Mathematics');
  const asg = ok(await admin('POST', '/api/assignments', { teacher_id: t.id, class_id: cls.id, learning_area_id: maths.id }));
  const edited = ok(await admin('PATCH', `/api/staff/${t.id}`, { full_name: 'Tom Leaver-Otieno', email: ' Tom.L@Gmail.com ', phone: '0700111222' }));
  assert.deepEqual([edited.full_name, edited.email], ['Tom Leaver-Otieno', 'tom.l@gmail.com']);
  assert.equal((await admin('PATCH', `/api/staff/${t.id}`, { email: 'not-an-email' })).status, 400);
  assert.equal((await admin('PATCH', `/api/staff/${t.id}`, { role: 'owner' })).status, 400);
  // The admin cannot remove themselves
  const me = ok(await admin('GET', '/api/me')).staff;
  assert.equal((await admin('PATCH', `/api/staff/${me.id}`, { active: false })).status, 400);

  ok(await admin('PATCH', `/api/staff/${t.id}`, { active: false }));
  const blocked = await admin('POST', '/api/assessments', { assignment_ids: [asg.id], kind: 'monthly', term: 1, year: cls.year, max_score: 10 });
  assert.equal(blocked.status, 400);
  assert.match(blocked.body.error, /Mathematics \(Tom Leaver-Otieno\): this teacher has been removed/);
  assert.equal((await admin('POST', '/api/assignments', { teacher_id: t.id, class_id: cls.id, learning_area_id: maths.id })).status, 400);
  const janet = fake.store.staff.find(s => s.full_name === 'Janet Wanjiku');
  ok(await admin('POST', '/api/assignments', { teacher_id: janet.id, class_id: cls.id, learning_area_id: maths.id }));
  assert.equal(fake.store.teacher_assignments.find(a => a.class_id === cls.id).teacher_id, janet.id);
});

test('scores typed in the app (no Google Sheet) are analysed and reach the report form', async () => {
  const cls = ok(await admin('POST', '/api/classes', { grade: 7, stream: 'South', year: new Date().getFullYear() }));
  const added = ok(await admin('POST', '/api/learners', { class_id: cls.id, learners: [
    { adm_no: '301', first_name: 'Neema', last_name: 'Wairimu' }, { adm_no: '302', first_name: 'Omondi', last_name: 'Ochieng' }] }));
  ok(await admin('POST', '/api/billing/pay', { learner_ids: added.added_ids, year: cls.year, term: 2, plan: 'term', mpesa_code: 'RBX1234567' }));
  const eng = ok(await admin('GET', '/api/curriculum')).find(a => a.name === 'English');
  const janet = fake.store.staff.find(s => s.full_name === 'Janet Wanjiku');
  const asg = ok(await admin('POST', '/api/assignments', { teacher_id: janet.id, class_id: cls.id, learning_area_id: eng.id }));
  const token = fake.store.schools[0].google_refresh_token;
  fake.store.schools[0].google_refresh_token = null; // Google not connected: the assessment stays a draft
  const a = ok(await admin('POST', '/api/assessments', { assignment_ids: [asg.id], kind: 'monthly', term: 2, year: cls.year, max_score: 40 })).created[0].assessment;
  fake.store.schools[0].google_refresh_token = token;
  assert.equal(a.status, 'draft');
  const detail = ok(await admin('GET', `/api/assessments/${a.id}`));
  assert.equal(detail.learners.length, 2);
  const [neema, omondi] = [added.added_ids[0], added.added_ids[1]];
  const comp = detail.components[0].id;
  const bad = await admin('POST', `/api/assessments/${a.id}/analyse`, { scores: [{ learner_id: neema, component_id: comp, raw_score: '45' }] });
  assert.equal(bad.status, 422);
  const out = ok(await admin('POST', `/api/assessments/${a.id}/analyse`, { scores: [
    { learner_id: neema, component_id: comp, raw_score: '30', comment: 'Lovely handwriting.' },
    { learner_id: omondi, component_id: comp, raw_score: '', absent: true },
    { learner_id: neema, component_id: 'someone-elses-component', raw_score: '1' },
  ] }));
  assert.deepEqual([out.summary.assessed, out.summary.absent, out.summary.mean_percent], [1, 1, 75]);
  const again = ok(await admin('GET', `/api/assessments/${a.id}`));
  assert.equal(again.scores.find(x => x.learner_id === neema).raw_score, '30');
  const report = ok(await admin('GET', `/api/reports/termly?class_id=${cls.id}&year=${cls.year}&term=2&learner_id=${neema}`)).reports[0];
  assert.equal(report.areas[eng.id].remark, 'Very good work. Keep it up!');
  assert.equal(report.areas[eng.id].average, 75);
});

test('deleting an assessment removes its results; not allowed once the term is closed', async () => {
  const a = fake.store.assessments.find(x => x.status === 'draft' && x.term === 1 && x.year === new Date().getFullYear() + 1)
    || fake.store.assessments.find(x => x.status === 'draft');
  ok(await admin('DELETE', `/api/assessments/${a.id}`));
  assert.ok(!fake.store.assessments.some(x => x.id === a.id));
  const analysed = fake.store.assessments.find(x => x.status === 'analysed' && x.term === 2);
  ok(await admin('POST', '/api/terms/close', { year: analysed.year, term: 2 }));
  assert.equal((await admin('DELETE', `/api/assessments/${analysed.id}`)).status, 400);
  ok(await admin('POST', '/api/terms/reopen', { year: analysed.year, term: 2 }));
  ok(await admin('DELETE', `/api/assessments/${analysed.id}`));
  assert.ok(!(fake.store.results || []).some(r => r.assessment_id === analysed.id));
});

test('school logo: only small real images are accepted, and it reaches the report form', async () => {
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  assert.equal(ok(await admin('PATCH', '/api/school', { logo: png })).school.logo, png);
  for (const bad of ['javascript:alert(1)', 'data:image/svg+xml;base64,PHN2Zz4=', 'data:image/png;base64,abc"onerror="x', 'data:text/html;base64,PGI+', `data:image/png;base64,${'A'.repeat(500 * 1024)}`]) {
    assert.equal((await admin('PATCH', '/api/school', { logo: bad })).status, 400, bad.slice(0, 30));
  }
  const cls = fake.store.classes.find(c => c.grade === 7 && c.stream === 'East');
  assert.equal(ok(await admin('GET', `/api/reports/termly?class_id=${cls.id}&year=${cls.year}&term=1`)).school.logo, png);
  assert.equal(ok(await admin('PATCH', '/api/school', { logo: null })).school.logo, null);
  assert.equal((await admin('PATCH', '/api/school', { name: '  ' })).status, 400);
});

test('school colour: a dark enough colour is saved and reaches the report form', async () => {
  const cls = fake.store.classes.find(c => c.grade === 7);
  assert.equal(ok(await admin('PATCH', '/api/school', { colour: '#7A1F2B' })).school.colour, '#7a1f2b');
  assert.equal(ok(await admin('GET', `/api/reports/termly?class_id=${cls.id}&year=${cls.year}&term=1`)).school.colour, '#7a1f2b');
  for (const bad of ['red', '#fff', '#ffff00', '#f5c542', 'url(x)', '#1f7a4d;color:red']) {
    assert.equal((await admin('PATCH', '/api/school', { colour: bad })).status, 400, bad);
  }
  ok(await admin('PATCH', '/api/school', { colour: '#1f7a4d' }));
});

test('only paid learners get a sheet row; learners paid later are added; the teacher sets what it is out of', async () => {
  const year = new Date().getFullYear();
  const cls = ok(await admin('POST', '/api/classes', { grade: 7, stream: 'West', year }));
  const added = ok(await admin('POST', '/api/learners', { class_id: cls.id, learners: [
    { adm_no: '701', first_name: 'Pendo', last_name: 'Mumbi' }, { adm_no: '702', first_name: 'Rehema', last_name: 'Juma' }] }));
  const [pendo, rehema] = added.added_ids;
  ok(await admin('POST', '/api/billing/pay', { learner_ids: [pendo], year, term: 1, plan: 'term', mpesa_code: 'WST0000001' }));
  const area = ok(await admin('GET', '/api/curriculum?grade=7')).find(a => a.name === 'Mathematics');
  const janet = fake.store.staff.find(s => s.full_name === 'Janet Wanjiku');
  const asg = ok(await admin('POST', '/api/assignments', { teacher_id: janet.id, class_id: cls.id, learning_area_id: area.id }));
  const strands = area.strands.slice(0, 2);
  const a = ok(await admin('POST', '/api/assessments', { assignment_ids: [asg.id], kind: 'custom', term: 1, year, per_strand: true, due_on: `${year}-03-27`,
    components: strands.map(s => ({ label: s.name, strand_id: s.id, max_score: 20 })) })).created[0].assessment;
  assert.equal(a.due_on, `${year}-03-27`);
  assert.equal((await admin('POST', '/api/assessments', { assignment_ids: [asg.id], kind: 'custom', term: 1, year, max_score: 10, due_on: 'soon' })).status, 400);
  // Rehema is not paid for: she is not on the teacher's sheet
  assert.deepEqual(created[created.length - 1].learners.map(l => l.first_name), ['Pendo']);
  let detail = ok(await admin('GET', `/api/assessments/${a.id}`));
  assert.deepEqual([detail.unpaid.map(l => l.name), detail.not_on_sheet], [['Rehema Juma'], []]);
  // Scores typed for an unpaid learner are ignored
  const typed = ok(await admin('POST', `/api/assessments/${a.id}/analyse`, { scores: detail.components.flatMap(c => [pendo, rehema].map(l => ({ learner_id: l, component_id: c.id, raw_score: '10' }))) }));
  assert.deepEqual(typed.results.map(r => r.learner_id), [pendo]);
  // Once paid for, she is added to the bottom of the same sheet automatically
  const paid = ok(await admin('POST', '/api/billing/pay', { learner_ids: [rehema], year, term: 1, plan: 'term', mpesa_code: 'WST0000002' }));
  assert.equal(paid.sheets_updated, 1);
  assert.deepEqual(appended[appended.length - 1].learners.map(l => l.first_name), ['Rehema']);
  detail = ok(await admin('GET', `/api/assessments/${a.id}`));
  assert.deepEqual([detail.unpaid, detail.not_on_sheet], [[], []]);
  assert.equal(ok(await admin('POST', `/api/assessments/${a.id}/sheet/learners`, {})).added, 0);

  // The teacher marked the first strand out of 50 instead of 20 (row 2 of the sheet)
  const layout = sheets.buildSheetLayout({ components: detail.components, learners: [] });
  sheetValues = [layout.header, ['', '', 'OUT OF →', 50, 20, '', ''], [pendo, '701', 'Pendo Mumbi', 40, 10, '', ''], [rehema, '702', 'Rehema Juma', 25, '', '', '']];
  const out = ok(await admin('POST', `/api/assessments/${a.id}/analyse`, {}));
  const byId = Object.fromEntries(out.results.map(r => [r.learner_id, r]));
  assert.equal(byId[pendo].percent, 71.4);           // (40 + 10) / (50 + 20)
  assert.equal(byId[pendo].strands[0].percent, 80);  // 40 / 50
  assert.equal(byId[rehema].percent, 50);            // only the strand entered so far: 25 / 50
  assert.equal(fake.store.assessment_components.find(c => c.id === detail.components[0].id).max_score, 50);
  // A score above the new "out of" is caught; so is a bad "out of"
  sheetValues = [layout.header, ['', '', 'OUT OF →', 50, 20, '', ''], [pendo, '701', 'Pendo Mumbi', 60, 10, '', '']];
  assert.equal((await admin('POST', `/api/assessments/${a.id}/analyse`, {})).status, 422);
  sheetValues = [layout.header, ['', '', 'OUT OF →', -5, 20, '', ''], [pendo, '701', 'Pendo Mumbi', 4, 10, '', '']];
  const bad = await admin('POST', `/api/assessments/${a.id}/analyse`, {});
  assert.equal(bad.status, 422);
  assert.match(bad.body.details[0], /Out of/);
});

test('one workbook per teacher: a tab for each learning area, each with its own strands', async () => {
  const year = new Date().getFullYear();
  const cls = ok(await admin('POST', '/api/classes', { grade: 7, stream: 'North', year }));
  const added = ok(await admin('POST', '/api/learners', { class_id: cls.id, learners: [
    { adm_no: '801', first_name: 'Kito', last_name: 'Mbugua' }, { adm_no: '802', first_name: 'Lulu', last_name: 'Achieng' }] }));
  ok(await admin('POST', '/api/billing/pay', { learner_ids: added.added_ids, year, term: 1, plan: 'term', mpesa_code: 'NTH0000001' }));
  const kirui = ok(await admin('POST', '/api/staff', { full_name: 'Peter Kirui', email: 'kirui@gmail.com' })).staff;
  const janet = fake.store.staff.find(s => s.full_name === 'Janet Wanjiku');
  const areas = ok(await admin('GET', '/api/curriculum?grade=7'));
  const area = n => areas.find(a => a.name === n);
  const asg = {};
  for (const [n, t] of [['Mathematics', kirui], ['Christian Religious Education', kirui], ['Agriculture and Nutrition', kirui], ['English', janet]]) {
    asg[n] = ok(await admin('POST', '/api/assignments', { teacher_id: t.id, class_id: cls.id, learning_area_id: area(n).id })).id;
  }
  // Curriculum strands where loaded (Maths, English); typed by the admin otherwise (CRE, Agriculture)
  const typed = { 'Christian Religious Education': ['Creation', 'The Bible'], 'Agriculture and Nutrition': ['Conserving Our Environment', 'Food Production'] };
  const strands = n => (area(n).strands.length ? area(n).strands.slice(0, 2).map(s => ({ label: s.name, strand_id: s.id, max_score: 20 }))
    : typed[n].map(label => ({ label, max_score: 20 })));
  // Several learning areas per strand at once need each area's own strands
  assert.equal((await admin('POST', '/api/assessments', { assignment_ids: Object.values(asg), kind: 'custom', term: 1, year, per_strand: true })).status, 400);
  const before = workbooks.length;
  const out = ok(await admin('POST', '/api/assessments', { assignment_ids: Object.values(asg), kind: 'custom', term: 1, year, per_strand: true, due_on: `${year}-03-27`,
    components_by_assignment: Object.fromEntries(Object.entries(asg).map(([n, id]) => [id, strands(n)])) }));
  // Two teachers → two workbooks (two emails), not four
  assert.equal(out.workbooks, 2);
  const [kWb, jWb] = workbooks.slice(before);
  assert.equal(kWb.shareWith, 'kirui@gmail.com');
  assert.deepEqual(kWb.tabs.map(t => t.title), ['Mathematics – Grade 7 North', 'Christian Religious Education – Grade 7 North', 'Agriculture and Nutrition – Grade 7 North']);
  assert.deepEqual(kWb.tabs.map(t => t.components.map(c => c.label)), ['Mathematics', 'Christian Religious Education', 'Agriculture and Nutrition'].map(n => strands(n).map(s => s.label)));
  assert.match(kWb.title, /Peter Kirui/);
  assert.match(kWb.message, /Please finish by 27 March/);
  assert.deepEqual(jWb.tabs.map(t => t.title), ['English – Grade 7 North']);
  assert.match(jWb.title, /English - Assessment Term 1/);
  const sent = out.created.map(c => c.assessment);
  assert.equal(new Set(sent.filter(a => a.teacher_id === kirui.id).map(a => a.sheet_id)).size, 1);
  // A learner paid for later is added to their tab in the same workbook
  const late = ok(await admin('POST', '/api/learners', { class_id: cls.id, learners: [{ adm_no: '803', first_name: 'Mosi', last_name: 'Tanui' }] })).added_ids;
  const n = appended.length;
  ok(await admin('POST', '/api/billing/pay', { learner_ids: late, year, term: 1, plan: 'term', mpesa_code: 'NTH0000002' }));
  const tabs = appended.slice(n).filter(x => sent.some(a => a.sheet_id === x.id)).map(x => x.tab).sort();
  assert.deepEqual(tabs, [...kWb.tabs.map(t => t.title), 'English – Grade 7 North'].sort());
});

test('getting started checklist reflects what the school has done', async () => {
  fake.users.set('new-admin', { id: 'u-new', email: 'head@newschool.ac.ke' });
  const fresh = as('new-admin');
  ok(await fresh('POST', '/api/schools', { name: 'New Hope Academy', full_name: 'Mary Head' }));
  let st = ok(await fresh('GET', '/api/setup-status'));
  assert.equal(st.done, false);
  assert.ok(st.steps.every(x => !x.done));
  ok(await fresh('PATCH', '/api/school', { head_teacher_name: 'Mrs M. Head', phone: '0700000000' }));
  ok(await fresh('POST', '/api/classes', { grade: 4, stream: 'Blue', year: new Date().getFullYear() }));
  st = ok(await fresh('GET', '/api/setup-status'));
  assert.deepEqual(st.steps.filter(x => x.done).map(x => x.key), ['details', 'classes']);
  // The first school is fully set up
  const first = ok(await admin('GET', '/api/setup-status'));
  assert.ok(first.steps.find(x => x.key === 'analysed').done);
});

test('security: input checks, sign-in state, other schools', async () => {
  const cls = fake.store.classes.find(c => c.grade === 7 && c.stream === 'East');
  assert.equal((await admin('POST', '/api/staff', { full_name: 'X', email: 'not an email' })).status, 400);
  assert.equal((await admin('POST', '/api/classes', { grade: 15, year: 2027 })).status, 400);
  assert.equal((await admin('POST', '/api/classes', { grade: 'abc', year: 2027 })).status, 400);
  const many = Array.from({ length: 2001 }, (_, i) => ({ first_name: 'A', last_name: String(i) }));
  assert.equal((await admin('POST', '/api/learners', { class_id: cls.id, learners: many })).status, 400);
  const asg = fake.store.teacher_assignments.find(a => a.class_id === cls.id);
  const comps = Array.from({ length: 41 }, (_, i) => ({ label: `S${i}`, max_score: 10 }));
  assert.equal((await admin('POST', '/api/assessments', { assignment_ids: [asg.id], kind: 'monthly', term: 1, year: cls.year, per_strand: true, components: comps })).status, 400);
  assert.equal((await admin('POST', '/api/assessments', { assignment_ids: [asg.id], kind: 'monthly', term: 4, year: cls.year, max_score: 10 })).status, 400);
  assert.equal((await admin('POST', '/api/assessments', { assignment_ids: [asg.id], kind: 'monthly', term: 1, year: cls.year, max_score: 5000 })).status, 400);
  assert.equal((await admin('PUT', '/api/terms', { year: cls.year, term: 1, closing_date: '<script>' })).status, 400);
  assert.equal((await admin('POST', '/api/billing/quote', { learner_ids: 'everyone', year: cls.year, term: 1, plan: 'term' })).status, 400);
  assert.equal((await admin('PUT', '/api/report-comments', { learner_id: fake.store.learners[0].id, year: cls.year, term: 9 })).status, 400);

  // Another school's admin cannot see or touch this school's records
  const other = as('new-admin');
  const learner = fake.store.learners.find(l => l.school_id === fake.store.schools[0].id);
  const a = fake.store.assessments.find(x => x.school_id === fake.store.schools[0].id);
  for (const [m, url, body] of [
    ['GET', `/api/assessments/${a.id}`], ['POST', `/api/assessments/${a.id}/analyse`, {}], ['DELETE', `/api/assessments/${a.id}`],
    ['PATCH', `/api/learners/${learner.id}`, { first_name: 'Hacked' }], ['GET', `/api/classes/${cls.id}/term?year=${cls.year}&term=1`],
    ['GET', `/api/reports/termly?class_id=${cls.id}&year=${cls.year}&term=1`], ['POST', `/api/classes/${cls.id}/promote`, { mode: 'complete' }],
    ['PUT', '/api/report-comments', { learner_id: learner.id, year: cls.year, term: 1, class_comment: 'x' }],
    ['POST', '/api/billing/pay', { learner_ids: [learner.id], year: cls.year, term: 1, plan: 'term' }],
  ]) {
    const r = await other(m, url, body);
    assert.ok([400, 404].includes(r.status), `${m} ${url} → ${r.status}`);
  }
  assert.notEqual(fake.store.learners.find(l => l.id === learner.id).first_name, 'Hacked');

  // Google sign-in state: forged, tampered or missing secret
  const { signState, verifyState } = require('../lib/auth');
  const good = signState({ school_id: 's1' });
  assert.equal(verifyState(good).school_id, 's1');
  assert.throws(() => verifyState(good.slice(0, -2) + 'xx'), /Invalid state/);
  assert.throws(() => verifyState('bm90LWpzb24.abc'), /Invalid state/);
  assert.equal((await call(api, 'GET', '/api/google/callback?code=x&state=abc.def', null, {})).status, 400);
  const saved = process.env.STATE_SECRET;
  process.env.STATE_SECRET = 'change-me';
  assert.throws(() => signState({}), /STATE_SECRET/);
  process.env.STATE_SECRET = saved;
});
