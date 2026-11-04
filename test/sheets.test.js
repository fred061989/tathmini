const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSheetLayout, parseSheetValues, colLetter, rowFormulas } = require('../lib/sheets');
const { buildScale } = require('../lib/cbc');

const components = [{ id: 'c1', label: 'Numbers', max_score: 20 }, { id: 'c2', label: 'Geometry', max_score: 10 }];
const learners = [{ id: 'l1', adm_no: '101', first_name: 'Amani', last_name: 'Otieno' }, { id: 'l2', adm_no: '102', first_name: 'Baraka', last_name: 'Kamau' }];

test('sheet layout: headings, an "Out of" row, then one row per learner', () => {
  const layout = buildSheetLayout({ components, learners });
  assert.deepEqual(layout.header, ['Learner ID', 'ADM No', 'Learner Name', 'Numbers', 'Geometry', '%', 'Level']);
  assert.deepEqual(layout.outOf, ['', '', 'OUT OF →', 20, 10, '', '']);
  assert.deepEqual(layout.rows[0], ['l1', '101', 'Amani Otieno', '', '', '', '']);
  assert.deepEqual([colLetter(0), colLetter(3), colLetter(25), colLetter(26), colLetter(27)], ['A', 'D', 'Z', 'AA', 'AB']);
});

test('reads marks; AB in a mark box means absent for that mark', () => {
  const { top } = buildSheetLayout({ components, learners });
  const { scores, issues, maxScores } = parseSheetValues([...top, ['l1', 101, 'Amani Otieno', 15, 7, 73.3, 'ME1'], ['l2', 102, 'Baraka Kamau', 'ab', 6, 60, 'ME1']], components, learners);
  assert.deepEqual(issues, []);
  assert.deepEqual(scores[0], { learner_id: 'l1', component_id: 'c1', raw_score: '15', absent: false, comment: null });
  assert.deepEqual([scores[2].raw_score, scores[2].absent, scores[3].absent], ['AB', true, false]);
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

test('the sheet works out % and the CBC level as the teacher types', () => {
  const f = rowFormulas(components, buildScale('cbc8').levels, 3, 4);
  assert.equal(f.range, 'F3:G4'); // after Numbers (D) and Geometry (E)
  assert.equal(f.values[0][0], '=IF(COUNT(D3:E3)=0,IF(COUNTIF(D3:E3,"AB")>0,"AB",""),ROUND(SUM(D3:E3)/SUMPRODUCT(ISNUMBER(D3:E3)*D$2:E$2)*100,1))');
  assert.equal(f.values[1][1], '=IF(ISNUMBER(F4),IF(F4>=90,"EE1",IF(F4>=75,"EE2",IF(F4>=58,"ME1",IF(F4>=41,"ME2",IF(F4>=31,"AE1",IF(F4>=21,"AE2",IF(F4>=11,"BE1","BE2"))))))),F4)');
  // A school's own thresholds are used
  assert.match(rowFormulas(components, buildScale('cbc4', { cbc4: { EE: 75 } }).levels, 3, 3).values[0][1], /F3>=75,"EE"/);
});
