// Term results: the class sheet (every learner × learning area) and each learner's
// termly report form. Pure: callers load the rows, this shapes them.
//
// How a term average is worked out, per learner and learning area:
//  1. the term's assessments are grouped by type (Opener, Weekly, Monthly, Mid-term, End-term, Other);
//  2. each type's score is the mean of that type's assessments (two monthly tests → their mean);
//  3. the term average is the mean of the type scores shown on the report.
// Absences are left out, not counted as zero. The overall average gives every
// learning area equal weight. Learners are not ranked (CBC guidance).

const { levelFor, mean, round1, meetingPercent } = require('./cbc');
const { LEARNING_AREAS } = require('../data/curriculum');

// Learning areas appear in the usual report-form order: languages, mathematics, sciences, …
const PREFERRED = ['English', 'Kiswahili', 'Kenyan Sign Language', 'Indigenous Language', 'Mathematics', 'Integrated Science',
  'Science and Technology', 'Pre-Technical Studies', 'Social Studies', 'Christian Religious Education', 'Islamic Religious Education',
  'Hindu Religious Education', 'Agriculture and Nutrition', 'Creative Arts and Sports', 'Creative Arts'];
const AREA_ORDER = [...PREFERRED, ...LEARNING_AREAS.map(a => a.name).filter(n => !PREFERRED.includes(n))];
function areaRank(name) {
  const i = AREA_ORDER.indexOf(name);
  return i === -1 ? AREA_ORDER.length : i;
}

const KIND_ORDER = ['opener', 'weekly', 'monthly', 'mid_term', 'end_term', 'custom'];
const KIND_LABEL = { opener: 'Opener', weekly: 'Weekly', monthly: 'Monthly', mid_term: 'Mid-term', end_term: 'End-term', custom: 'Other' };

function initials(name) {
  return String(name || '').split(/\s+/).filter(w => w && !/^(mr|mrs|ms|miss|dr|tr)\.?$/i.test(w))
    .map(w => w[0].toUpperCase() + '.').join('');
}

function listText(xs) {
  if (xs.length <= 1) return xs.join('');
  return `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
}

/**
 * @param {object} p
 * @param {Array<{id, first_name, last_name, adm_no?, assessment_no?}>} p.learners
 * @param {Array<{id, learning_area_id, learning_areas: {name, code}, kind, assessed_on, staff?: {full_name}}>} p.assessments  analysed, in the term
 * @param {Array<{assessment_id, learner_id, status, percent, strands?}>} p.results
 * @param {Array<{assessment_id, learner_id, comment}>} [p.comments]  teachers' comments from the sheets
 * @param {object} p.scale
 */
function buildTerm({ learners, assessments, results, comments = [], scale }) {
  const kinds = KIND_ORDER.filter(k => assessments.some(a => a.kind === k));
  const columns = kinds.map(k => ({ kind: k, label: KIND_LABEL[k] }));
  const areaMap = new Map();
  for (const a of [...assessments].sort((x, y) => String(x.assessed_on).localeCompare(String(y.assessed_on)))) {
    if (!areaMap.has(a.learning_area_id)) {
      areaMap.set(a.learning_area_id, { id: a.learning_area_id, name: a.learning_areas.name, code: a.learning_areas.code, assessments: [] });
    }
    areaMap.get(a.learning_area_id).assessments.push(a);
  }
  const areas = [...areaMap.values()].sort((x, y) => areaRank(x.name) - areaRank(y.name) || x.name.localeCompare(y.name));
  const resultOf = new Map(results.map(r => [`${r.assessment_id}:${r.learner_id}`, r]));
  const commentOf = new Map(comments.filter(c => c.comment).map(c => [`${c.assessment_id}:${c.learner_id}`, c.comment]));
  const threshold = meetingPercent(scale);

  const rows = learners.map(l => {
    const perArea = {};
    const strandMarks = new Map();
    for (const area of areas) {
      const cells = {};
      for (const k of kinds) {
        const rs = area.assessments.filter(a => a.kind === k).map(a => resultOf.get(`${a.id}:${l.id}`)).filter(Boolean);
        const scored = rs.filter(r => r.status === 'assessed' && r.percent != null).map(r => Number(r.percent));
        if (scored.length) cells[k] = { percent: round1(mean(scored)) };
        else if (rs.some(r => r.status === 'absent')) cells[k] = { absent: true };
      }
      const avg = mean(Object.values(cells).map(c => c.percent ?? null));
      // Latest comment the teacher wrote for this learner, and that teacher's initials.
      const latestFirst = [...area.assessments].reverse();
      const withComment = latestFirst.find(a => commentOf.has(`${a.id}:${l.id}`));
      const teacher = latestFirst.find(a => a.staff?.full_name)?.staff?.full_name || null;
      perArea[area.id] = {
        cells,
        average: round1(avg),
        level: levelFor(avg, scale)?.code ?? null,
        comment: withComment ? commentOf.get(`${withComment.id}:${l.id}`) : null,
        teacher_initials: teacher ? initials(teacher) : null,
      };
      for (const a of area.assessments) {
        const r = resultOf.get(`${a.id}:${l.id}`);
        if (!r || r.status !== 'assessed' || (r.strands || []).length < 2) continue;
        for (const s of r.strands) {
          if (s.percent == null) continue;
          const key = `${area.name} › ${s.label}`;
          if (!strandMarks.has(key)) strandMarks.set(key, []);
          strandMarks.get(key).push(s.percent);
        }
      }
    }
    const overall = mean(Object.values(perArea).map(x => x.average));
    const scoredAreas = areas.filter(a => perArea[a.id].average != null);
    const byAverage = [...scoredAreas].sort((x, y) => perArea[y.id].average - perArea[x.id].average);
    return {
      learner_id: l.id,
      name: `${l.first_name} ${l.last_name}`.trim(),
      first_name: l.first_name,
      adm_no: l.adm_no || null,
      assessment_no: l.assessment_no || null,
      areas: perArea,
      overall_percent: round1(overall),
      overall_level: levelFor(overall, scale)?.code ?? null,
      overall_label: levelFor(overall, scale)?.label ?? null,
      meeting: scoredAreas.filter(a => perArea[a.id].average >= threshold).length,
      assessed_areas: scoredAreas.length,
      strongest: byAverage.filter(a => perArea[a.id].average >= threshold).slice(0, 3).map(a => a.name),
      // Whether the strongest learning areas are at "exceeding expectations" (for the comment wording).
      strongest_exceeding: byAverage.filter(a => perArea[a.id].average >= threshold).slice(0, 3)
        .every(a => scale.levels.find(l => l.code === perArea[a.id].level).points > (scale.id === 'cbc8' ? 6 : 3)),
      needs_support: byAverage.filter(a => perArea[a.id].average < threshold).reverse().map(a => a.name),
      weak_strands: [...strandMarks.entries()]
        .map(([label, xs]) => ({ label, percent: round1(mean(xs)) }))
        .filter(s => s.percent < threshold).sort((a, b) => a.percent - b.percent).slice(0, 3),
    };
  });

  const withOverall = rows.filter(r => r.overall_percent != null);
  const classMean = mean(withOverall.map(r => r.overall_percent));
  return {
    scale: scale.id,
    columns,
    areas: areas.map(a => {
      const m = mean(rows.map(r => r.areas[a.id].average));
      return { id: a.id, name: a.name, code: a.code, assessments: a.assessments.length, mean_percent: round1(m), level: levelFor(m, scale)?.code ?? null };
    }),
    learners: rows,
    assessments: assessments.length,
    class_mean_percent: round1(classMean),
    class_level: levelFor(classMean, scale)?.code ?? null,
    meeting_or_above: withOverall.filter(r => scale.levels.find(l => l.code === r.overall_level).points >= scale.meetingPoints).length,
  };
}

// Drafts the class teacher's comment from the learner's term results (the admin can edit it).
function draftClassComment(row, scale) {
  if (row.overall_percent == null) return '';
  const name = row.first_name;
  const pts = scale.levels.find(l => l.code === row.overall_level).points;
  const top = scale.levels[0].points;
  const strong = row.strongest.length ? `, with ${row.strongest_exceeding ? 'excellent' : 'good'} work in ${listText(row.strongest)}` : '';
  const weakArea = row.needs_support[0];
  const weakStrand = row.weak_strands.find(s => weakArea && s.label.startsWith(weakArea));
  const support = weakArea
    ? ` ${weakArea} needs extra effort${weakStrand ? `, especially ${weakStrand.label.split(' › ')[1]}` : ''}.`
    : '';
  if (pts >= top - (scale.id === 'cbc8' ? 1 : 0)) {
    return `${name} has had an excellent term, exceeding expectations overall${strong}.${support} Keep it up!`;
  }
  if (pts >= scale.meetingPoints) {
    const fair = row.needs_support.length >= 3;
    return `${name} has had a ${fair ? 'fair' : 'good'} term, meeting expectations or above in ${row.meeting} of ${row.assessed_areas} learning areas${strong}.${support}`
      + (fair ? ` More effort in ${listText(row.needs_support.slice(0, 3))} will help.` : ' Keep it up!');
  }
  if (pts >= scale.meetingPoints - (scale.id === 'cbc8' ? 2 : 1)) {
    return `${name} is making progress and is approaching expectations overall${strong}.${support} More practice at home and in class will help.`;
  }
  return `${name} needs close support to reach expectations.${support || ''} Let us work together, at school and at home, to help ${name} improve.`;
}

// Drafts a short head teacher's comment from the overall level (the admin can edit it).
function draftHeadComment(row, scale) {
  if (row.overall_percent == null) return '';
  const pts = scale.levels.find(l => l.code === row.overall_level).points;
  const area = row.needs_support[0];
  if (pts >= scale.levels[0].points - (scale.id === 'cbc8' ? 1 : 0)) return 'Excellent results. Keep up the hard work.';
  if (pts >= scale.meetingPoints && row.needs_support.length >= 3) return `A fair term. More effort is needed in ${listText(row.needs_support.slice(0, 2))}.`;
  if (pts >= scale.meetingPoints) return `A good term's work.${area ? ` Keep up the effort in ${area}.` : ' Keep it up.'}`;
  if (pts >= scale.meetingPoints - (scale.id === 'cbc8' ? 2 : 1)) return `Fair progress. More effort is needed${area ? ` in ${area}` : ''}.`;
  return 'Needs close support. Please work with the school to help the learner improve.';
}

module.exports = { buildTerm, draftClassComment, draftHeadComment, KIND_ORDER, KIND_LABEL, initials };
