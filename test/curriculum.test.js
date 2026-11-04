const test = require('node:test');
const assert = require('node:assert/strict');
const { parseGrade, parseCurriculumCsv, groupCurriculum, toCsv } = require('../lib/curriculum');
const { starterRows } = require('../data/curriculum');

test('grades in any common spelling', () => {
  assert.deepEqual(['PP1', 'pp 2', 'Grade 7', 'G9', '4', 0, 'Grade 13', 'Form 1'].map(parseGrade), [-1, 0, 7, 9, 4, 0, null, null]);
});

test('CSV with quotes, tabs and no header', () => {
  assert.equal(parseCurriculumCsv('Grade 7,Mathematics,MAT,Measurements,"Time, Distance and Speed"')[0].sub_strand, 'Time, Distance and Speed');
  assert.deepEqual(parseCurriculumCsv('grade\tlearning_area\tstrand\nGrade 7\tEnglish\tReading')[0], { grade: 'Grade 7', learning_area: 'English', strand: 'Reading' });
});

test('groups rows and reports invalid ones', () => {
  const { areas, errors } = groupCurriculum([
    { grade: 'Grade 7', learning_area: 'Mathematics', code: 'mat', strand: 'Numbers', sub_strand: 'Fractions' },
    { grade: 'Grade 7', learning_area: 'mathematics', strand: 'Numbers', sub_strand: 'Decimals' },
    { grade: 'Grade 8', learning_area: 'Mathematics' },
  ]);
  assert.deepEqual(errors, []);
  assert.deepEqual([areas[0].code, areas[0].grades], ['MAT', [7, 8]]);
  assert.deepEqual(areas[0].strands[7], [{ name: 'Numbers', subs: ['Fractions', 'Decimals'] }]);
  assert.equal(groupCurriculum([{ grade: 'Form 1', learning_area: 'X' }, { grade: '7', learning_area: 'E', sub_strand: 'P' }]).errors.length, 2);
});

test('starter curriculum is valid and round-trips through CSV', () => {
  const { areas, errors } = groupCurriculum(starterRows());
  assert.deepEqual(errors, []);
  assert.equal(areas.length, 20);
  const asDb = areas.map(a => ({ ...a, strands: Object.entries(a.strands).flatMap(([g, list]) =>
    list.map((s, i) => ({ grade: Number(g), name: s.name, sort_order: i, sub_strands: s.subs.map((n, j) => ({ name: n, sort_order: j })) }))) }));
  assert.deepEqual(groupCurriculum(parseCurriculumCsv(toCsv(asDb))).areas, areas);
});
