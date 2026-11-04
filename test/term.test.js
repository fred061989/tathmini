const test = require('node:test');
const assert = require('node:assert/strict');
const { buildTerm, draftClassComment, draftHeadComment, initials } = require('../lib/term');
const { buildScale } = require('../lib/cbc');

const scale = buildScale('cbc8');
const maths = { name: 'Mathematics', code: 'MAT' };
const eng = { name: 'English', code: 'ENG' };
const learners = [{ id: 'a', first_name: 'Amani', last_name: 'Otieno', adm_no: '100' }, { id: 'b', first_name: 'Baraka', last_name: 'Kamau' }];
const assessments = [
  { id: 'm1', learning_area_id: 'M', learning_areas: maths, kind: 'monthly', assessed_on: '2027-02-01', staff: { full_name: 'Mr Wafula Mwangi' } },
  { id: 'm2', learning_area_id: 'M', learning_areas: maths, kind: 'monthly', assessed_on: '2027-03-01', staff: { full_name: 'Mr Wafula Mwangi' } },
  { id: 'm3', learning_area_id: 'M', learning_areas: maths, kind: 'end_term', assessed_on: '2027-03-28', staff: { full_name: 'Mr Wafula Mwangi' } },
  { id: 'e1', learning_area_id: 'E', learning_areas: eng, kind: 'end_term', assessed_on: '2027-03-27', staff: { full_name: 'Janet Wanjiku' } },
];
const r = (assessment_id, learner_id, percent, status = 'assessed', strands = []) => ({ assessment_id, learner_id, percent, status, strands });
const results = [
  r('m1', 'a', 60), r('m2', 'a', 80), r('m3', 'a', 90, 'assessed', [{ label: 'Numbers', percent: 95 }, { label: 'Geometry', percent: 30 }]),
  r('e1', 'a', 40),
  r('m1', 'b', null, 'absent'), r('m2', 'b', null, 'absent'), r('m3', 'b', 50), r('e1', 'b', 70),
];
const comments = [{ assessment_id: 'm1', learner_id: 'a', comment: 'Old comment' }, { assessment_id: 'm3', learner_id: 'a', comment: 'Revise geometry.' }];

test('term average: each assessment type counts once', () => {
  const t = buildTerm({ learners, assessments, results, comments, scale });
  assert.deepEqual(t.columns.map(c => c.label), ['Monthly', 'End-term']);
  const amani = t.learners[0];
  // Monthly = mean(60, 80) = 70; End-term = 90; term average = mean(70, 90) = 80
  assert.deepEqual(amani.areas.M.cells, { monthly: { percent: 70 }, end_term: { percent: 90 } });
  assert.equal(amani.areas.M.average, 80);
  assert.equal(amani.areas.M.level, 'EE2');
  assert.equal(amani.overall_percent, 60); // (80 + 40) / 2, each learning area equal
});

test('absences are shown, not counted as zero', () => {
  const t = buildTerm({ learners, assessments, results, comments, scale });
  const baraka = t.learners[1];
  assert.deepEqual(baraka.areas.M.cells, { monthly: { absent: true }, end_term: { percent: 50 } });
  assert.equal(baraka.areas.M.average, 50);
});

test("teacher's latest comment and initials", () => {
  const t = buildTerm({ learners, assessments, results, comments, scale });
  assert.equal(t.learners[0].areas.M.comment, 'Revise geometry.');
  assert.equal(t.learners[0].areas.M.teacher_initials, 'W.M.');
  assert.equal(t.learners[0].areas.E.comment, null);
  assert.equal(initials('Mrs Janet Wanjiku'), 'J.W.');
});

test('strengths, needs support, strands and class means', () => {
  const t = buildTerm({ learners, assessments, results, comments, scale });
  const amani = t.learners[0];
  assert.deepEqual(amani.strongest, ['Mathematics']);
  assert.deepEqual(amani.needs_support, ['English']);
  assert.deepEqual(amani.weak_strands, [{ label: 'Mathematics › Geometry', percent: 30 }]);
  assert.equal(t.areas.find(a => a.id === 'M').mean_percent, 65); // (80 + 50) / 2
  assert.equal(t.class_mean_percent, 60);
});

test('comment drafts follow the results', () => {
  const t = buildTerm({ learners, assessments, results, comments, scale });
  const c = draftClassComment(t.learners[0], scale);
  assert.match(c, /^Amani has had a good term, meeting expectations or above in 1 of 2 learning areas, with excellent work in Mathematics\. English needs extra effort\. Keep it up!$/);
  assert.equal(draftHeadComment(t.learners[0], scale), "A good term's work. Keep up the effort in English.");
  const top = { ...t.learners[0], overall_percent: 92, overall_level: 'EE1' };
  assert.match(draftClassComment(top, scale), /excellent term/);
  const low = { ...t.learners[0], overall_percent: 15, overall_level: 'BE1', strongest: [] };
  assert.match(draftClassComment(low, scale), /needs close support/);
  assert.equal(draftClassComment({ ...t.learners[0], overall_percent: null }, scale), '');
});

test('learning areas follow the usual report order, not the alphabet', () => {
  const t = buildTerm({ learners, assessments, results, comments, scale });
  assert.deepEqual(t.areas.map(a => a.name), ['English', 'Mathematics']);
  const extra = [...assessments, { id: 'k1', learning_area_id: 'K', learning_areas: { name: 'Kiswahili', code: 'KIS' }, kind: 'end_term', assessed_on: '2027-03-27' },
    { id: 'z1', learning_area_id: 'Z', learning_areas: { name: 'Agriculture and Nutrition', code: 'AGN' }, kind: 'end_term', assessed_on: '2027-03-27' }];
  assert.deepEqual(buildTerm({ learners, assessments: extra, results, scale }).areas.map(a => a.name), ['English', 'Kiswahili', 'Mathematics', 'Agriculture and Nutrition']);
});

test("comments only say 'excellent' for exceeding expectations, and 'fair' when several areas need support", () => {
  const base = { first_name: 'Dalia', overall_percent: 48.7, overall_level: 'ME2', meeting: 5, assessed_areas: 9, weak_strands: [] };
  const fair = { ...base, strongest: ['Integrated Science'], strongest_exceeding: false, needs_support: ['English', 'Kiswahili', 'Mathematics', 'Social Studies'] };
  assert.equal(draftClassComment(fair, scale),
    'Dalia has had a fair term, meeting expectations or above in 5 of 9 learning areas, with good work in Integrated Science. English needs extra effort. More effort in English, Kiswahili and Mathematics will help.');
  assert.equal(draftHeadComment(fair, scale), 'A fair term. More effort is needed in English and Kiswahili.');
  const good = { ...base, overall_percent: 70, overall_level: 'ME1', strongest: ['Kiswahili'], strongest_exceeding: true, needs_support: [] };
  assert.match(draftClassComment(good, scale), /good term.*excellent work in Kiswahili\. Keep it up!$/);
});

test('primary (4-level) term results and comments', () => {
  const s4 = buildScale('cbc4');
  const sci = { name: 'Science and Technology', code: 'SCT' };
  const a = [
    { id: 'p1', learning_area_id: 'S', learning_areas: sci, kind: 'end_term', assessed_on: '2027-03-27' },
    { id: 'p2', learning_area_id: 'E', learning_areas: eng, kind: 'end_term', assessed_on: '2027-03-27' },
    { id: 'p3', learning_area_id: 'M', learning_areas: maths, kind: 'end_term', assessed_on: '2027-03-27' },
  ];
  const res = [r('p1', 'a', 85), r('p2', 'a', 82), r('p3', 'a', 45), r('p1', 'b', 40), r('p2', 'b', 25), r('p3', 'b', 20)];
  const t = buildTerm({ learners, assessments: a, results: res, scale: s4 });
  const [amani, baraka] = t.learners;
  assert.deepEqual([amani.areas.S.level, amani.areas.M.level, amani.overall_level], ['EE', 'AE', 'ME']);
  assert.equal(amani.strongest_exceeding, true);
  assert.match(draftClassComment(amani, s4), /^Amani has had a good term, meeting expectations or above in 2 of 3 learning areas, with excellent work in Science and Technology and English\. Mathematics needs extra effort\. Keep it up!$/);
  assert.deepEqual([baraka.overall_level, baraka.needs_support.length], ['BE', 3]);
  assert.match(draftClassComment(baraka, s4), /^Baraka needs close support to reach expectations\./);
  assert.equal(draftHeadComment(baraka, s4), 'Needs close support. Please work with the school to help the learner improve.');
  assert.deepEqual(t.areas.map(x => x.name), ['English', 'Mathematics', 'Science and Technology']);
});
