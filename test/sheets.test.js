const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSheetLayout, parseSheetValues } = require('../lib/sheets');

const components = [{ id: 'c1', label: 'Numbers', max_score: 20 }, { id: 'c2', label: 'Geometry', max_score: 10 }];
const learners = [{ id: 'l1', adm_no: '101', first_name: 'Amani', last_name: 'Otieno' }, { id: 'l2', adm_no: '102', first_name: 'Baraka', last_name: 'Kamau' }];

test('sheet layout', () => {
  const layout = buildSheetLayout({ components, learners });
  assert.deepEqual(layout.header, ['Learner ID', 'ADM No', 'Learner Name', 'Numbers (/20)', 'Geometry (/10)', 'Absent (Y)', 'Comment']);
  assert.deepEqual(layout.rows[0], ['l1', '101', 'Amani Otieno', '', '', '', '']);
});

test('reads scores, absences and comments', () => {
  const { header } = buildSheetLayout({ components, learners });
  const { scores, issues } = parseSheetValues([header, ['l1', 101, 'Amani Otieno', 15, 7, '', 'Good work'], ['l2', 102, 'Baraka Kamau', '', '', 'y']], components, learners);
  assert.deepEqual(issues, []);
  assert.deepEqual(scores[0], { learner_id: 'l1', component_id: 'c1', raw_score: '15', absent: false, comment: 'Good work' });
  assert.equal(scores[2].absent, true);
});

test('rejects edited headers; flags unknown and missing learners', () => {
  assert.equal(parseSheetValues([['Learner ID', 'ADM No', 'Learner Name', 'Geometry (/10)', 'Numbers (/20)']], components, learners).issues.length, 2);
  const { header } = buildSheetLayout({ components, learners });
  const { scores, issues } = parseSheetValues([header, ['l1', '', '', 1, 1], ['zzz', '', 'Stranger', 1, 1]], components, learners);
  assert.equal(scores.length, 2);
  assert.equal(issues.length, 2);
});
