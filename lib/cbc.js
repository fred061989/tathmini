// CBC grading scales and helpers.
//
// Two rubrics are in use in Kenyan schools:
//  - cbc4: the 4-level rubric for PP1–Grade 6 (EE / ME / AE / BE)
//  - cbc8: the 8-level KNEC rubric for Junior School, Grade 7–9 (EE1 … BE2)
// Thresholds are the defaults; each school can override them (schools.grading).

const SCALES = {
  cbc4: {
    id: 'cbc4',
    meetingPoints: 3,
    levels: [
      { code: 'EE', label: 'Exceeding Expectations', min: 80, points: 4 },
      { code: 'ME', label: 'Meeting Expectations', min: 50, points: 3 },
      { code: 'AE', label: 'Approaching Expectations', min: 30, points: 2 },
      { code: 'BE', label: 'Below Expectations', min: 0, points: 1 },
    ],
  },
  cbc8: {
    id: 'cbc8',
    meetingPoints: 5,
    levels: [
      { code: 'EE1', label: 'Exceeding Expectations', min: 90, points: 8 },
      { code: 'EE2', label: 'Exceeding Expectations', min: 75, points: 7 },
      { code: 'ME1', label: 'Meeting Expectations', min: 58, points: 6 },
      { code: 'ME2', label: 'Meeting Expectations', min: 41, points: 5 },
      { code: 'AE1', label: 'Approaching Expectations', min: 31, points: 4 },
      { code: 'AE2', label: 'Approaching Expectations', min: 21, points: 3 },
      { code: 'BE1', label: 'Below Expectations', min: 11, points: 2 },
      { code: 'BE2', label: 'Below Expectations', min: 0, points: 1 },
    ],
  },
};

// Grades are stored as integers: PP1 = -1, PP2 = 0, Grade 1 = 1 … Grade 12 = 12.
function gradeLabel(grade) {
  const g = Number(grade);
  if (g === -1) return 'PP1';
  if (g === 0) return 'PP2';
  return `Grade ${g}`;
}

// overrides: { cbc4: { EE: 75, ME: 50, AE: 25 }, cbc8: { EE1: 90, ... } }
function buildScale(id, overrides = {}) {
  const base = SCALES[id];
  if (!base) throw new Error(`Unknown grading scale: ${id}`);
  const custom = overrides[id] || {};
  const levels = base.levels
    .map(l => ({ ...l, min: custom[l.code] != null ? Number(custom[l.code]) : l.min }))
    .sort((a, b) => b.min - a.min);
  levels[levels.length - 1].min = 0;
  return { ...base, levels };
}

function scaleForGrade(grade, overrides) {
  return buildScale(Number(grade) >= 7 ? 'cbc8' : 'cbc4', overrides);
}

function levelFor(percent, scale) {
  if (percent == null || !Number.isFinite(percent)) return null;
  return scale.levels.find(l => percent >= l.min) || scale.levels[scale.levels.length - 1];
}

// Lowest percentage that still counts as "meeting expectations".
function meetingPercent(scale) {
  const lvl = scale.levels.filter(l => l.points >= scale.meetingPoints).pop();
  return lvl ? lvl.min : 50;
}

function round1(n) {
  return n == null || !Number.isFinite(n) ? null : Math.round(n * 10) / 10;
}

function mean(nums) {
  const xs = nums.filter(n => n != null && Number.isFinite(n));
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

module.exports = { SCALES, gradeLabel, buildScale, scaleForGrade, levelFor, meetingPercent, round1, mean };
