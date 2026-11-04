const test = require('node:test');
const assert = require('node:assert/strict');
const { analyseAssessment } = require('../lib/analysis');
const { buildScale } = require('../lib/cbc');

const components = [{ id: 'c1', label: 'Numbers', max_score: 20, sort_order: 0 }, { id: 'c2', label: 'Geometry', max_score: 10, sort_order: 1 }];
const learners = [
  { id: 'a', first_name: 'Amani', last_name: 'Otieno' }, { id: 'b', first_name: 'Baraka', last_name: 'Kamau' },
  { id: 'c', first_name: 'Chebet', last_name: 'Kiprop' }, { id: 'd', first_name: 'Dalia', last_name: 'Wanjiru' },
];
const scores = [
  { learner_id: 'a', component_id: 'c1', raw_score: '18' }, { learner_id: 'a', component_id: 'c2', raw_score: '9' },
  { learner_id: 'b', component_id: 'c1', raw_score: 8 }, { learner_id: 'b', component_id: 'c2', raw_score: '1' },
  { learner_id: 'c', component_id: 'c1', raw_score: '', absent: true }, { learner_id: 'c', component_id: 'c2', raw_score: '', absent: true },
];

test('per-learner results with strands', () => {
  const { results, errors } = analyseAssessment({ components, learners, scores, scale: buildScale('cbc8') });
  assert.deepEqual(errors, []);
  const a = results.find(r => r.learner_id === 'a');
  assert.deepEqual([a.percent, a.level, a.strands[0].level], [90, 'EE1', 'EE1']);
  const b = results.find(r => r.learner_id === 'b');
  assert.deepEqual([b.percent, b.level, b.strands[1].level], [30, 'AE2', 'BE2']);
  assert.equal(results.find(r => r.learner_id === 'c').status, 'absent');
  assert.equal(results.find(r => r.learner_id === 'd').status, 'missing');
});

test('class summary excludes absent and missing learners', () => {
  const { summary } = analyseAssessment({ components, learners, scores, scale: buildScale('cbc8') });
  assert.deepEqual([summary.assessed, summary.absent, summary.missing, summary.mean_percent, summary.mean_level], [2, 1, 1, 60, 'ME1']);
  assert.deepEqual(summary.needs_support.map(n => n.name), ['Baraka Kamau']);
  assert.equal(summary.components[1].mean_percent, 50);
});

test('invalid scores are reported, not counted', () => {
  const bad = [...scores, { learner_id: 'd', component_id: 'c1', raw_score: '25' }, { learner_id: 'd', component_id: 'c2', raw_score: 'abc' }];
  const { errors, results } = analyseAssessment({ components, learners, scores: bad, scale: buildScale('cbc8') });
  assert.equal(errors.length, 2);
  assert.match(errors[0].message, /0 to 20/);
  assert.equal(results.find(r => r.learner_id === 'd').status, 'missing');
});

test('progress against the previous assessment', () => {
  const { results, summary } = analyseAssessment({ components, learners, scores, scale: buildScale('cbc8'),
    previous: [{ learner_id: 'a', percent: 80 }, { learner_id: 'b', percent: 40 }] });
  assert.equal(results.find(r => r.learner_id === 'a').change, 10);
  assert.deepEqual(summary.most_improved.map(m => m.learner_id), ['a']);
});

test('AB in a mark box: that strand is left out, the rest still count', () => {
  const s = [
    { learner_id: 'a', component_id: 'c1', raw_score: 'ab' }, { learner_id: 'a', component_id: 'c2', raw_score: '9' },
    { learner_id: 'b', component_id: 'c1', raw_score: 'AB' }, { learner_id: 'b', component_id: 'c2', raw_score: 'AB' },
    { learner_id: 'c', component_id: 'c1', raw_score: 'away' },
  ];
  const { results, errors } = analyseAssessment({ components, learners, scores: s, scale: buildScale('cbc8') });
  const a = results.find(r => r.learner_id === 'a');
  assert.deepEqual([a.status, a.percent, a.strands[0].absent, a.strands[0].percent], ['assessed', 90, true, null]); // 9/10 only
  assert.equal(results.find(r => r.learner_id === 'b').status, 'absent');
  assert.match(errors[0].message, /or AB if absent/);
});
