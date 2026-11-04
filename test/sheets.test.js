const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSheetLayout, parseSheetValues, colLetter } = require('../lib/sheets');

const components = [{ id: 'c1', label: 'Numbers', max_score: 20 }, { id: 'c2', label: 'Geometry', max_score: 10 }];
const learners = [{ id: 'l1', adm_no: '101', first_name: 'Amani', last_name: 'Otieno' }, { id: 'l2', adm_no: '102', first_name: 'Baraka', last_name: 'Kamau' }];

test('sheet layout: headings, an "Out of" row, then one row per learner', () => {
  const layout = buildSheetLayout({ components, learners });
  assert.deepEqual(layout.header, ['Learner ID', 'ADM No', 'Learner Name', 'Numbers', 'Geometry', 'Absent (Y)', 'Comment']);
  assert.deepEqual(layout.outOf, ['', '', 'OUT OF →', 20, 10, '', '']);
  assert.deepEqual(layout.rows[0], ['l1', '101', 'Amani Otieno', '', '', '', '']);
  assert.deepEqual([colLetter(0), colLetter(3), colLetter(25), colLetter(26), colLetter(27)], ['A', 'D', 'Z', 'AA', 'AB']);
});

test('reads scores, absences and comments', () => {
  const { top } = buildSheetLayout({ components, learners });
  const { scores, issues, maxScores } = parseSheetValues([...top, ['l1', 101, 'Amani Otieno', 15, 7, '', 'Good work'], ['l2', 102, 'Baraka Kamau', '', '', 'y']], components, learners);
  assert.deepEqual(issues, []);
  assert.deepEqual(scores[0], { learner_id: 'l1', component_id: 'c1', raw_score: '15', absent: false, comment: 'Good work' });
  assert.equal(scores[2].absent, true);
  assert.deepEqual(maxScores, [{ component_id: 'c1', max_score: 20 }, { component_id: 'c2', max_score: 10 }]);
});

test('the teacher can change what a column is out of', () => {
  const { header } = buildSheetLayout({ components, learners });
  const { maxScores, outOfErrors } = parseSheetValues([header, ['', '', 'OUT OF →', 50, ''], ['l1', 101, 'Amani Otieno', 40, 7]], components, learners);
  assert.deepEqual(maxScores.map(m => m.max_score), [50, 10]); // blank keeps the admin's value
  assert.deepEqual(outOfErrors, []);
  assert.equal(parseSheetValues([header, ['', '', 'OUT OF →', 0, 'ten']], components, learners).outOfErrors.length, 2);
});

test('rejects edited headers or a missing "Out of" row; flags unknown and missing learners', () => {
  assert.equal(parseSheetValues([['Learner ID', 'ADM No', 'Learner Name', 'Geometry', 'Numbers']], components, learners).issues.length, 3);
  const { header, top } = buildSheetLayout({ components, learners });
  assert.match(parseSheetValues([header, ['l1', '', '', 1, 1]], components, learners).issues[0], /Out of/);
  const { scores, issues } = parseSheetValues([...top, ['l1', '', '', 1, 1], ['zzz', '', 'Stranger', 1, 1]], components, learners);
  assert.equal(scores.length, 2);
  assert.equal(issues.length, 2);
});
