// Assessments, all driven by the school admin: create an assessment for a teacher's
// learning area, a Google Sheet is generated and shared with the teacher, the teacher
// fills in scores, the admin checks progress and presses Analyse.

const { db, must, one } = require('../db');
const { HttpError, readJson, required } = require('../http');
const { requireAdmin } = require('../auth');
const { scaleForGrade, gradeLabel } = require('../cbc');
const { analyseAssessment } = require('../analysis');
const { paidLearnerIds } = require('../billing');
const sheets = require('../sheets');

const KINDS = { opener: 'Opener', weekly: 'Weekly', monthly: 'Monthly', mid_term: 'Mid-term', end_term: 'End-term', custom: 'Assessment' };
const ASSESSMENT_SELECT = '*, classes(id, grade, stream, year), learning_areas(id, name, code), staff!assessments_teacher_id_fkey(id, full_name, email)';

function classLabel(c) {
  return `${gradeLabel(c.grade)}${c.stream ? ' ' + c.stream : ''}`;
}

function defaultTitle({ cls, area, kind, week, term, year }) {
  const when = [week ? `Week ${week}` : null, term ? `Term ${term}` : null, year].filter(Boolean).join(' ');
  return `${classLabel(cls)} ${area.name} - ${KINDS[kind] || 'Assessment'} ${when}`.replace(/\s+/g, ' ').trim();
}

async function loadAssessment(id, admin) {
  return one(await db().from('assessments').select(ASSESSMENT_SELECT).eq('id', id).eq('school_id', admin.school_id).maybeSingle(), 'Assessment');
}

async function loadComponents(assessmentId) {
  return must(await db().from('assessment_components').select('*').eq('assessment_id', assessmentId).order('sort_order'));
}

// Learners in the class whose learner fee is paid for the assessment's year.
async function loadClassLearners(assessment) {
  const [learners, paid] = await Promise.all([
    db().from('learners').select('id, adm_no, first_name, last_name').eq('class_id', assessment.class_id).eq('active', true)
      .order('first_name').order('last_name').then(must),
    paidLearnerIds(assessment.school_id, assessment.year),
  ]);
  return learners.filter(l => paid.has(l.id));
}

async function school(id) {
  return must(await db().from('schools').select('*').eq('id', id).single());
}

async function termClosed(schoolId, year, term) {
  const t = must(await db().from('terms').select('closed_at').eq('school_id', schoolId).eq('year', year).eq('term', term).maybeSingle());
  return Boolean(t?.closed_at);
}

async function generateSheet(assessment, sch) {
  if (!sch.google_refresh_token) throw new HttpError(400, 'Connect the school Google account (Settings) before generating sheets');
  const [components, learners] = await Promise.all([loadComponents(assessment.id), loadClassLearners(assessment)]);
  if (!learners.length) throw new HttpError(400, `This class has no learners paid for ${assessment.year} yet`);
  const { spreadsheetId, url } = await sheets.createAssessmentSheet(sch.google_refresh_token, {
    title: `${sch.short_name || sch.name} - ${assessment.title}`,
    components,
    learners,
    shareWith: assessment.staff?.email,
    message: `Please enter the scores for "${assessment.title}". Fill only the score columns, mark absent learners with Y, and add a short comment for each learner if you can. Your changes save automatically.`,
  });
  return must(await db().from('assessments').update({ sheet_id: spreadsheetId, sheet_url: url, status: 'sheet_ready' })
    .eq('id', assessment.id).select(ASSESSMENT_SELECT).single());
}

// The most recent analysed assessment for the same class and learning area, before this one.
async function previousResults(a) {
  const prev = must(await db().from('assessments').select('id')
    .eq('class_id', a.class_id).eq('learning_area_id', a.learning_area_id).eq('status', 'analysed').neq('id', a.id)
    .lte('assessed_on', a.assessed_on).order('assessed_on', { ascending: false }).order('created_at', { ascending: false }).limit(1));
  if (!prev.length) return { id: null, results: [] };
  return { id: prev[0].id, results: must(await db().from('results').select('learner_id, percent').eq('assessment_id', prev[0].id)) };
}

// A learner is entered when marked absent or every strand has a score; "partial" have only some.
function sheetProgress(scores, learners) {
  const byLearner = new Map();
  for (const s of scores) {
    if (!byLearner.has(s.learner_id)) byLearner.set(s.learner_id, []);
    byLearner.get(s.learner_id).push(s);
  }
  let entered = 0;
  let partial = 0;
  for (const l of learners) {
    const own = byLearner.get(l.id) || [];
    const filled = own.filter(s => s.raw_score != null).length;
    if (own.some(s => s.absent) || (own.length && filled === own.length)) entered++;
    else if (filled) partial++;
  }
  return { entered, partial, total: learners.length, complete: entered === learners.length && learners.length > 0 };
}

const routes = [
  ['GET', '/api/assessments', async ({ req, query }) => {
    const admin = await requireAdmin(req);
    let q = db().from('assessments').select(ASSESSMENT_SELECT).eq('school_id', admin.school_id);
    if (query.status) q = q.in('status', query.status.split(','));
    if (query.class_id) q = q.eq('class_id', query.class_id);
    if (query.term) q = q.eq('term', Number(query.term));
    if (query.year) q = q.eq('year', Number(query.year));
    return must(await q.order('assessed_on', { ascending: false }).order('created_at', { ascending: false }).limit(300));
  }],

  // Creates one assessment (and sheet) per selected teacher assignment.
  // Body: { assignment_ids, kind, term, year, week?, assessed_on?, title?, per_strand,
  //         components: [{ label, max_score, strand_id?, sub_strand_id? }] } — or { max_score } for a single total.
  // Per-strand assessments are created one learning area at a time, since strands differ per area.
  ['POST', '/api/assessments', async ({ req }) => {
    const admin = await requireAdmin(req);
    const body = await readJson(req);
    const ids = body.assignment_ids || [];
    required(body, ['kind', 'year', 'term']);
    if (!ids.length) throw new HttpError(400, 'Choose at least one learning area');
    if (!KINDS[body.kind]) throw new HttpError(400, `kind must be one of: ${Object.keys(KINDS).join(', ')}`);
    if (body.per_strand && ids.length > 1) throw new HttpError(400, 'Per-strand assessments are created one learning area at a time');
    if (await termClosed(admin.school_id, Number(body.year), Number(body.term))) throw new HttpError(400, `Term ${body.term} ${body.year} is closed`);

    let components = Array.isArray(body.components) ? body.components : [];
    if (!body.per_strand && !components.length) components = [{ label: 'Total', max_score: body.max_score }];
    if (!components.length) throw new HttpError(400, 'Add at least one strand to assess');
    components.forEach((c, i) => {
      if (!c.label || !(Number(c.max_score) > 0)) throw new HttpError(400, `Strand ${i + 1} needs a name and a maximum score above 0`);
    });

    const assignments = must(await db().from('teacher_assignments').select('*, classes(*), learning_areas(*)')
      .in('id', ids).eq('school_id', admin.school_id));
    if (assignments.length !== ids.length) throw new HttpError(404, 'Some learning area assignments were not found');
    const sch = await school(admin.school_id);

    const created = [];
    for (const asg of assignments) {
      const assessment = must(await db().from('assessments').insert({
        school_id: admin.school_id, assignment_id: asg.id, class_id: asg.class_id, learning_area_id: asg.learning_area_id,
        teacher_id: asg.teacher_id,
        title: (assignments.length === 1 && body.title?.trim()) || defaultTitle({ cls: asg.classes, area: asg.learning_areas, ...body }),
        kind: body.kind, per_strand: Boolean(body.per_strand), term: Number(body.term), year: Number(body.year),
        week: body.week ? Number(body.week) : null, assessed_on: body.assessed_on || new Date().toISOString().slice(0, 10),
      }).select(ASSESSMENT_SELECT).single());
      must(await db().from('assessment_components').insert(components.map((c, i) => ({
        assessment_id: assessment.id, strand_id: c.strand_id || null, sub_strand_id: c.sub_strand_id || null,
        label: String(c.label).trim(), max_score: Number(c.max_score), sort_order: i,
      }))));
      if (!sch.google_refresh_token) {
        created.push({ assessment, note: 'Saved as a draft; connect Google in Settings to send the sheet' });
        continue;
      }
      try {
        created.push({ assessment: await generateSheet(assessment, sch) });
      } catch (err) {
        console.error('Sheet generation failed', err);
        created.push({ assessment, note: `Saved, but the sheet could not be created: ${err.message}` });
      }
    }
    return { created };
  }],

  ['GET', '/api/assessments/:id', async ({ req, params }) => {
    const admin = await requireAdmin(req);
    const assessment = await loadAssessment(params.id, admin);
    const [components, results] = await Promise.all([
      loadComponents(assessment.id),
      db().from('results').select('*, learners(id, adm_no, first_name, last_name)').eq('assessment_id', assessment.id).then(must),
    ]);
    results.sort((a, b) => `${a.learners.first_name} ${a.learners.last_name}`.localeCompare(`${b.learners.first_name} ${b.learners.last_name}`));
    return { assessment, components, results };
  }],

  // (Re)generates the sheet, e.g. after connecting Google or adding learners.
  ['POST', '/api/assessments/:id/sheet', async ({ req, params }) => {
    const admin = await requireAdmin(req);
    const assessment = await loadAssessment(params.id, admin);
    if (assessment.status === 'analysed') throw new HttpError(400, 'This assessment is already analysed');
    return { assessment: await generateSheet(assessment, await school(admin.school_id)) };
  }],

  ['GET', '/api/assessments/:id/progress', async ({ req, params }) => {
    const admin = await requireAdmin(req);
    const assessment = await loadAssessment(params.id, admin);
    if (!assessment.sheet_id) throw new HttpError(400, 'This assessment has no sheet yet');
    const [components, learners, sch] = await Promise.all([loadComponents(assessment.id), loadClassLearners(assessment), school(admin.school_id)]);
    const values = await sheets.readAssessmentSheet(sch.google_refresh_token, assessment.sheet_id);
    const { scores, issues } = sheets.parseSheetValues(values, components, learners);
    return { ...sheetProgress(scores, learners), issues };
  }],

  ['DELETE', '/api/assessments/:id', async ({ req, params }) => {
    const admin = await requireAdmin(req);
    const assessment = await loadAssessment(params.id, admin);
    if (await termClosed(admin.school_id, assessment.year, assessment.term)) throw new HttpError(400, `Term ${assessment.term} ${assessment.year} is closed`);
    must(await db().from('assessments').delete().eq('id', assessment.id));
  }],

  // Reads the sheet (or body.scores for manual entry), validates and analyses.
  ['POST', '/api/assessments/:id/analyse', async ({ req, params }) => {
    const admin = await requireAdmin(req);
    const assessment = await loadAssessment(params.id, admin);
    if (await termClosed(admin.school_id, assessment.year, assessment.term)) {
      throw new HttpError(400, `Term ${assessment.term} ${assessment.year} is closed; reopen it to change results`);
    }
    const body = await readJson(req);
    const [components, learners, sch] = await Promise.all([loadComponents(assessment.id), loadClassLearners(assessment), school(admin.school_id)]);

    let scores;
    let issues = [];
    if (Array.isArray(body.scores)) {
      scores = body.scores;
    } else {
      if (!assessment.sheet_id) throw new HttpError(400, 'This assessment has no sheet yet');
      if (!sch.google_refresh_token) throw new HttpError(400, 'Google account is not connected');
      const values = await sheets.readAssessmentSheet(sch.google_refresh_token, assessment.sheet_id);
      ({ scores, issues } = sheets.parseSheetValues(values, components, learners));
      if (!scores.length && issues.length) throw new HttpError(422, 'The sheet layout was changed', issues);
    }

    const scale = scaleForGrade(assessment.classes.grade, sch.grading);
    const prev = await previousResults(assessment);
    const analysis = analyseAssessment({ components, learners, scores, scale, previous: prev.results });
    if (analysis.errors.length) throw new HttpError(422, `${analysis.errors.length} score(s) need correcting in the sheet`, analysis.errors.map(e => e.message));
    if (!analysis.summary.assessed) throw new HttpError(422, 'No scores have been entered yet');

    const known = new Set(learners.map(l => l.id));
    const rows = scores.filter(s => known.has(s.learner_id)).map(s => ({
      assessment_id: assessment.id, learner_id: s.learner_id, component_id: s.component_id,
      raw_score: s.raw_score == null ? null : String(s.raw_score), absent: Boolean(s.absent), comment: s.comment || null,
    }));
    must(await db().from('scores').delete().eq('assessment_id', assessment.id));
    if (rows.length) must(await db().from('scores').insert(rows));
    must(await db().from('results').delete().eq('assessment_id', assessment.id));
    must(await db().from('results').insert(analysis.results.map(r => ({
      assessment_id: assessment.id, learner_id: r.learner_id, status: r.status, percent: r.percent,
      level: r.level, points: r.points, change: r.change, strands: r.strands,
    }))));
    const summary = { ...analysis.summary, previous_assessment_id: prev.id, sheet_issues: issues };
    const updated = must(await db().from('assessments').update({ summary, status: 'analysed', analysed_at: new Date().toISOString() })
      .eq('id', assessment.id).select(ASSESSMENT_SELECT).single());
    return { assessment: updated, summary, results: analysis.results, issues };
  }],
];

module.exports = { routes, KINDS, classLabel, sheetProgress };
