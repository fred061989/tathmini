const test = require('node:test');
const assert = require('node:assert/strict');
const { buildScale, scaleForGrade, levelFor, meetingPercent, gradeLabel } = require('../lib/cbc');

test('primary uses the 4-level rubric, junior school the 8-level one', () => {
  assert.equal(scaleForGrade(4).id, 'cbc4');
  assert.equal(scaleForGrade(-1).id, 'cbc4');
  assert.equal(scaleForGrade(7).id, 'cbc8');
});

test('8-level boundaries', () => {
  const s = buildScale('cbc8');
  const cases = [[100, 'EE1'], [90, 'EE1'], [89.9, 'EE2'], [75, 'EE2'], [58, 'ME1'], [57, 'ME2'], [41, 'ME2'],
    [40, 'AE1'], [31, 'AE1'], [30, 'AE2'], [21, 'AE2'], [20, 'BE1'], [11, 'BE1'], [10, 'BE2'], [0, 'BE2']];
  for (const [pct, code] of cases) assert.equal(levelFor(pct, s).code, code, `${pct}%`);
});

test('4-level boundaries and school overrides', () => {
  const s = buildScale('cbc4');
  assert.equal(levelFor(80, s).code, 'EE');
  assert.equal(levelFor(79, s).code, 'ME');
  assert.equal(levelFor(29, s).code, 'BE');
  const custom = buildScale('cbc4', { cbc4: { EE: 75, AE: 25 } });
  assert.equal(levelFor(76, custom).code, 'EE');
  assert.equal(levelFor(26, custom).code, 'AE');
});

test('meeting threshold and grade labels', () => {
  assert.equal(meetingPercent(buildScale('cbc8')), 41);
  assert.equal(meetingPercent(buildScale('cbc4')), 50);
  assert.equal(gradeLabel(-1), 'PP1');
  assert.equal(gradeLabel(8), 'Grade 8');
  assert.equal(levelFor(null, buildScale('cbc4')), null);
});
