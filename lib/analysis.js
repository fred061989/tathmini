// Turns raw scores for one assessment into CBC results.
// Pure: no database or network access, so it is easy to test.
//
// CBC guidance discourages ranking learners, so results carry levels,
// strand breakdowns and progress against the previous assessment, not positions.

const { levelFor, mean, round1, meetingPercent } = require('./cbc');

function isBlank(v) {
  return v == null || (typeof v === 'string' && v.trim() === '');
}

// A mark of "AB" (any case) means the learner was absent for that strand or test.
const isAbsentMark = s => Boolean(s && (s.absent || /^ab$/i.test(String(s.raw_score ?? '').trim())));

function distribution(levels, scale) {
  const out = Object.fromEntries(scale.levels.map(l => [l.code, 0]));
  for (const l of levels) if (l) out[l.code] += 1;
  return out;
}

/**
 * @param {object} p
 * @param {Array<{id,label,max_score,sort_order?}>} p.components  strands (or a single "Total")
 * @param {Array<{id,first_name,last_name}>} p.learners
 * @param {Array<{learner_id,component_id,raw_score,absent?}>} p.scores  raw_score "AB" = absent for that mark
 * @param {object} p.scale  from cbc.buildScale
 * @param {Array<{learner_id,percent}>} [p.previous]  results of the previous comparable assessment
 */
function analyseAssessment({ components, learners, scores, scale, previous = [] }) {
  const comps = [...components].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  const scoreMap = new Map(scores.map(s => [`${s.learner_id}:${s.component_id}`, s]));
  const prev = new Map(previous.filter(r => r.percent != null).map(r => [r.learner_id, Number(r.percent)]));
  const errors = [];

  const rows = learners.map(l => {
    const name = `${l.first_name} ${l.last_name}`.trim();
    const own = comps.map(c => scoreMap.get(`${l.id}:${c.id}`));
    let got = 0;
    let max = 0;
    let absentMarks = 0;

    // Each mark counts on its own: AB marks are left out (not zero); the rest are added up.
    const strands = comps.map((c, i) => {
      const s = own[i];
      const base = { component_id: c.id, label: c.label, max_score: Number(c.max_score), raw: null, percent: null, level: null };
      if (isAbsentMark(s)) { absentMarks++; return { ...base, absent: true }; }
      if (!s || isBlank(s.raw_score)) return base;
      const v = Number(s.raw_score);
      if (!Number.isFinite(v) || v < 0 || v > Number(c.max_score)) {
        errors.push({ learner_id: l.id, learner: name, component: c.label, value: s.raw_score,
          message: `${name}: "${s.raw_score}" for ${c.label} must be a number from 0 to ${c.max_score}, or AB if absent` });
        return base;
      }
      got += v;
      max += Number(c.max_score);
      const pct = (v / Number(c.max_score)) * 100;
      const lvl = levelFor(pct, scale);
      return { ...base, raw: v, percent: round1(pct), level: lvl.code, points: lvl.points };
    });

    const status = max > 0 ? 'assessed' : absentMarks ? 'absent' : 'missing';
    const percent = status === 'assessed' ? (got / max) * 100 : null;
    const lvl = levelFor(percent, scale);
    const before = prev.get(l.id);
    return {
      learner_id: l.id,
      name,
      status,
      percent: round1(percent),
      level: lvl ? lvl.code : null,
      points: lvl ? lvl.points : null,
      strands,
      change: percent != null && before != null ? round1(percent - before) : null,
    };
  });

  const assessed = rows.filter(r => r.status === 'assessed');
  const meanPct = mean(assessed.map(r => r.percent));
  const threshold = meetingPercent(scale);
  const componentSummary = comps.map((c, i) => {
    const vals = assessed.map(r => r.strands[i]).filter(s => s.percent != null);
    const m = mean(vals.map(s => s.percent));
    return {
      component_id: c.id,
      label: c.label,
      mean_percent: round1(m),
      level: levelFor(m, scale)?.code ?? null,
      distribution: distribution(vals.map(s => scale.levels.find(x => x.code === s.level)), scale),
      needs_support: vals.filter(s => s.points < scale.meetingPoints).length,
    };
  });
  const withChange = assessed.filter(r => r.change != null);

  const summary = {
    scale: scale.id,
    learners: rows.length,
    assessed: assessed.length,
    absent: rows.filter(r => r.status === 'absent').length,
    missing: rows.filter(r => r.status === 'missing').length,
    mean_percent: round1(meanPct),
    mean_level: levelFor(meanPct, scale)?.code ?? null,
    distribution: distribution(assessed.map(r => scale.levels.find(x => x.code === r.level)), scale),
    meeting_or_above: assessed.filter(r => r.points >= scale.meetingPoints).length,
    components: componentSummary,
    weak_components: componentSummary.filter(c => c.mean_percent != null && c.mean_percent < threshold).map(c => c.label),
    needs_support: assessed.filter(r => r.points < scale.meetingPoints)
      .map(r => ({ learner_id: r.learner_id, name: r.name, level: r.level, percent: r.percent })),
    most_improved: withChange.filter(r => r.change > 0).sort((a, b) => b.change - a.change).slice(0, 5)
      .map(r => ({ learner_id: r.learner_id, name: r.name, change: r.change })),
    mean_change: round1(mean(withChange.map(r => r.change))),
  };

  return { results: rows, summary, errors };
}

module.exports = { analyseAssessment };
