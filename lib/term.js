// Term results: the class sheet (every learner × learning area) and each learner's
// termly report form; and the end-of-year results (Term 1, 2 and 3 and their average).
// Pure: callers load the rows, this shapes them.
//
// A school chooses how a term average is worked out, per learner and learning area:
//
// "exams" (mid-term, end-term type assessments):
//  1. the term's assessments are grouped by type (Opener, Weekly, Monthly, Mid-term, End-term, Other);
//  2. each type's score is the mean of that type's assessments (two monthly tests → their mean);
//  3. the term average is the mean of the type scores shown on the report.
//
// "strands" (strand by strand, added up over the term or the period the admin set):
//  1. every mark a learner gets for a strand during the term is collected, whatever the assessment;
//  2. each strand's percentage = marks scored ÷ marks possible for that strand (e.g. 14/20 + 30/50 → 44/70 = 62.9%),
//     and gets its own level;
//  3. the term percentage adds up all the strand marks the same way: total scored ÷ total possible.
//  Assessments scored only as a total count when a learning area has no strand marks at all.
//  Each mark is out of whatever the teacher marked it out of (the sheet's "Out of" row).
//
// Absences are left out, not counted as zero. The overall average gives every
// learning area equal weight. Learners are not ranked (CBC guidance).

const { levelFor, mean, round1, meetingPercent, rubricRemark } = require('./cbc');
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
 * @param {object} p.scale
 * @param {'exams'|'strands'} [p.style]
 * @param {Array<{id, assessment_id, label, strands?: {name, sort_order}}>} [p.components]  needed for "strands"
 */
function buildTerm({ learners, assessments, results, scale, style = 'exams', components = [] }) {
  const byStrand = style === 'strands';
  const kinds = byStrand ? [] : KIND_ORDER.filter(k => assessments.some(a => a.kind === k));
  const columns = kinds.map(k => ({ kind: k, label: KIND_LABEL[k] }));
  // Which strand each scored component belongs to (a sub-strand counts towards its strand).
  const perStrand = new Map(assessments.map(a => [a.id, Boolean(a.per_strand)]));
  const strandOf = new Map();
  for (const c of components) {
    const name = c.strands?.name || (perStrand.get(c.assessment_id) ? String(c.label || '').trim() : '');
    if (name) strandOf.set(c.id, { name, order: c.strands?.sort_order ?? 1000 });
  }
  const areaMap = new Map();
  for (const a of [...assessments].sort((x, y) => String(x.assessed_on).localeCompare(String(y.assessed_on)))) {
    if (!areaMap.has(a.learning_area_id)) {
      areaMap.set(a.learning_area_id, { id: a.learning_area_id, name: a.learning_areas.name, code: a.learning_areas.code, assessments: [] });
    }
    areaMap.get(a.learning_area_id).assessments.push(a);
  }
  const areas = [...areaMap.values()].sort((x, y) => areaRank(x.name) - areaRank(y.name) || x.name.localeCompare(y.name));
  // Each learning area's strands, in curriculum order.
  for (const area of areas) {
    const ids = new Set(area.assessments.map(a => a.id));
    const seen = new Map();
    for (const c of components) {
      const st = ids.has(c.assessment_id) && strandOf.get(c.id);
      if (st && !seen.has(st.name)) seen.set(st.name, st.order);
    }
    area.strands = [...seen.entries()].sort((x, y) => x[1] - y[1]).map(([name]) => name);
  }
  const resultOf = new Map(results.map(r => [`${r.assessment_id}:${r.learner_id}`, r]));
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
      let avg;
      let strands;
      if (byStrand) {
        // Every strand mark of the term, added up per strand; totals only when there are no strand marks.
        const add = (acc, got, max) => { acc.got += got; acc.max += max; acc.n++; };
        const marks = new Map(area.strands.map(n => [n, { got: 0, max: 0, n: 0 }]));
        const totals = { got: 0, max: 0, n: 0 };
        for (const a of area.assessments) {
          const r = resultOf.get(`${a.id}:${l.id}`);
          if (!r || r.status !== 'assessed') continue;
          let used = false;
          const loose = { got: 0, max: 0, n: 0 };
          for (const sm of r.strands || []) {
            if (sm.percent == null) continue;
            // Marks and their maximum; older results without them fall back to the percentage (out of 100).
            const got = sm.raw != null && sm.max_score ? Number(sm.raw) : Number(sm.percent);
            const max = sm.raw != null && sm.max_score ? Number(sm.max_score) : 100;
            const st = strandOf.get(sm.component_id);
            if (st) { add(marks.get(st.name), got, max); used = true; } else add(loose, got, max);
          }
          if (!used && loose.n) add(totals, loose.got, loose.max);
          else if (!used && r.percent != null) add(totals, Number(r.percent), 100);
        }
        const pctOf = acc => (acc.max ? (acc.got / acc.max) * 100 : null);
        strands = area.strands.map(name => {
          const acc = marks.get(name);
          const m = pctOf(acc);
          return { name, percent: round1(m), level: levelFor(m, scale)?.code ?? null, marks: acc.n, scored: acc.got, out_of: acc.max };
        });
        const all = [...marks.values()].reduce((t, acc) => ({ got: t.got + acc.got, max: t.max + acc.max }), { got: 0, max: 0 });
        avg = all.max ? pctOf(all) : pctOf(totals);
        if (avg == null && area.assessments.some(a => resultOf.get(`${a.id}:${l.id}`)?.status === 'absent')) cells.absent = { absent: true };
      } else {
        avg = mean(Object.values(cells).map(c => c.percent ?? null));
      }
      // The subject teacher's initials (latest assessment), and the rubric remark for the level.
      const latestFirst = [...area.assessments].reverse();
      const teacher = latestFirst.find(a => a.staff?.full_name)?.staff?.full_name || null;
      const level = levelFor(avg, scale)?.code ?? null;
      const weakest = byStrand ? strands.filter(x => x.percent != null && x.percent < threshold).sort((a, b) => a.percent - b.percent)[0] : null;
      perArea[area.id] = {
        cells,
        average: round1(avg),
        level,
        remark: rubricRemark(level, scale, weakest?.name),
        teacher_initials: teacher ? initials(teacher) : null,
        ...(byStrand ? { strands } : {}),
      };
      if (byStrand) {
        for (const st of strands) if (st.percent != null) strandMarks.set(`${area.name} › ${st.name}`, [st.percent]);
        continue;
      }
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
    return {
      ...learnerSummary(l, areas, perArea, scale),
      weak_strands: [...strandMarks.entries()]
        .map(([label, xs]) => ({ label, percent: round1(mean(xs)) }))
        .filter(s => s.percent < threshold).sort((a, b) => a.percent - b.percent).slice(0, 3),
    };
  });
  return { ...classSummary(rows, scale), style, columns, areas: areas.map(a => {
    const m = mean(rows.map(r => r.areas[a.id].average));
    return { id: a.id, name: a.name, code: a.code, assessments: a.assessments.length, mean_percent: round1(m), level: levelFor(m, scale)?.code ?? null,
      ...(byStrand ? { strands: a.strands } : {}) };
  }), learners: rows, assessments: assessments.length };
}

// A learner's overall result, strengths and areas needing support, from their learning-area averages.
function learnerSummary(l, areas, perArea, scale) {
  const threshold = meetingPercent(scale);
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
      .every(a => scale.levels.find(x => x.code === perArea[a.id].level).points > (scale.id === 'cbc8' ? 6 : 3)),
    needs_support: byAverage.filter(a => perArea[a.id].average < threshold).reverse().map(a => a.name),
    weak_strands: [],
  };
}

function classSummary(rows, scale) {
  const withOverall = rows.filter(r => r.overall_percent != null);
  const classMean = mean(withOverall.map(r => r.overall_percent));
  return {
    scale: scale.id,
    class_mean_percent: round1(classMean),
    class_level: levelFor(classMean, scale)?.code ?? null,
    meeting_or_above: withOverall.filter(r => scale.levels.find(l => l.code === r.overall_level).points >= scale.meetingPoints).length,
  };
}

/**
 * End-of-year results: each learning area's Term 1, 2 and 3 averages and the year average
 * (the mean of the terms with results, so a term with no assessments does not count as zero).
 * @param {Array<{term: number, data: ReturnType<typeof buildTerm>}>} terms
 * @param {Array<{id, first_name, last_name, adm_no?, assessment_no?}>} learners
 */
function buildYear(terms, learners, scale) {
  const areaMap = new Map();
  for (const { data } of terms) for (const a of data.areas) if (!areaMap.has(a.id)) areaMap.set(a.id, { id: a.id, name: a.name, code: a.code });
  const areas = [...areaMap.values()].sort((x, y) => areaRank(x.name) - areaRank(y.name) || x.name.localeCompare(y.name));
  const rowOf = terms.map(({ term, data }) => ({ term, rows: new Map(data.learners.map(r => [r.learner_id, r])) }));
  const rows = learners.map(l => {
    const perArea = {};
    for (const area of areas) {
      const termAvg = {};
      let teacher = null;
      for (const { term, rows: m } of rowOf) {
        const v = m.get(l.id)?.areas[area.id];
        if (v?.average != null) termAvg[term] = v.average;
        if (v?.teacher_initials) teacher = v.teacher_initials;
      }
      const avg = mean(Object.values(termAvg));
      const level = levelFor(avg, scale)?.code ?? null;
      perArea[area.id] = { terms: termAvg, average: round1(avg), level, remark: rubricRemark(level, scale), teacher_initials: teacher };
    }
    const terms_overall = Object.fromEntries(rowOf.map(({ term, rows: m }) => [term, m.get(l.id)?.overall_percent ?? null]));
    return { ...learnerSummary(l, areas, perArea, scale), terms_overall };
  }).filter(r => r.assessed_areas);
  return {
    ...classSummary(rows, scale),
    terms: terms.map(t => t.term),
    areas: areas.map(a => {
      const m = mean(rows.map(r => r.areas[a.id].average));
      return { ...a, mean_percent: round1(m), level: levelFor(m, scale)?.code ?? null };
    }),
    learners: rows,
  };
}

// Drafts the class teacher's comment from the learner's term (or year) results (the admin can edit it).
function draftClassComment(row, scale, period = 'term') {
  if (row.overall_percent == null) return '';
  const name = row.first_name;
  const pts = scale.levels.find(l => l.code === row.overall_level).points;
  const top = scale.levels[0].points;
  const strong = row.strongest.length ? `, with ${row.strongest_exceeding ? 'excellent' : 'good'} work in ${listText(row.strongest)}` : '';
  const weakArea = row.needs_support[0];
  const weakStrand = row.weak_strands.find(s => weakArea && s.label.startsWith(weakArea));
  const support = weakArea
    ? ` Next, focus on ${weakArea}${weakStrand ? `, especially ${weakStrand.label.split(' › ')[1]}` : ''}.`
    : '';
  if (pts >= top - (scale.id === 'cbc8' ? 1 : 0)) {
    return `${name} has had an excellent ${period}, exceeding expectations overall${strong}.${support} Keep it up!`;
  }
  if (pts >= scale.meetingPoints) {
    const fair = row.needs_support.length >= 3;
    return `${name} has had a ${fair ? 'fair' : 'good'} ${period}, meeting expectations or above in ${row.meeting} of ${row.assessed_areas} learning areas${strong}.${support}`
      + (fair ? ` More effort in ${listText(row.needs_support.slice(0, 3))} will help.` : ' Keep it up!');
  }
  if (pts >= scale.meetingPoints - (scale.id === 'cbc8' ? 2 : 1)) {
    return `${name} is making progress and is approaching expectations overall${strong}.${support} More practice at home and in class will help.`;
  }
  return `${name} is growing steadily${strong}.${support} With extra practice and support, at school and at home, ${name} will keep improving.`;
}

// Drafts a short head teacher's comment from the overall level (the admin can edit it).
function draftHeadComment(row, scale, period = 'term') {
  if (row.overall_percent == null) return '';
  const pts = scale.levels.find(l => l.code === row.overall_level).points;
  const area = row.needs_support[0];
  if (pts >= scale.levels[0].points - (scale.id === 'cbc8' ? 1 : 0)) return 'Excellent results. Keep up the hard work.';
  if (pts >= scale.meetingPoints && row.needs_support.length >= 3) return `A fair ${period}. More effort is needed in ${listText(row.needs_support.slice(0, 2))}.`;
  if (pts >= scale.meetingPoints) return `A good ${period}'s work.${area ? ` Keep up the effort in ${area}.` : ' Keep it up.'}`;
  if (pts >= scale.meetingPoints - (scale.id === 'cbc8' ? 2 : 1)) return `Fair progress. More effort is needed${area ? ` in ${area}` : ''}.`;
  return 'Keep working hard. With support at school and at home, steady progress will come.';
}

module.exports = { buildTerm, buildYear, draftClassComment, draftHeadComment, KIND_ORDER, KIND_LABEL, initials };
