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

// Learners in the class who are paid for the assessment's term.
async function loadClassLearners(assessment) {
  const [learners, paid] = await Promise.all([
    db().from('learners').select('id, adm_no, first_name, last_name').eq('class_id', assessment.class_id).eq('active', true)
      .order('first_name').order('last_name').then(must),
    paidLearnerIds(assessment.school_id, assessment.year, assessment.term),
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

const longDate = d => new Date(d + 'T00:00:00').toLocaleDateString('en-KE', { day: 'numeric', month: 'long', year: 'numeric' });

/**
 * Sends one teacher's assessments as ONE Google workbook (one email), with a tab per learning area
 * and class. Assessments whose class has no paid-for learners are skipped (reported in `skipped`).
 * @returns {{ sent: object[], skipped: Array<{ assessment, note }> }}
 */
async function generateWorkbook(list, sch, title) {
  if (!sch.google_refresh_token) throw new HttpError(400, 'Connect the school Google account (Settings) before generating sheets');
  const prepared = [];
  const skipped = [];
  for (const a of list) {
    const [components, learners] = await Promise.all([loadComponents(a.id), loadClassLearners(a)]);
    if (learners.length) prepared.push({ a, components, learners });
    else skipped.push({ assessment: a, note: `Saved, but not sent: this class has no learners paid for Term ${a.term} ${a.year} yet` });
  }
  if (!prepared.length) return { sent: [], skipped };
  const tabs = prepared.map(({ a, components, learners }) => ({
    title: `${a.learning_areas.name} – ${classLabel(a.classes)}`, components, learners, levels: scaleForGrade(a.classes.grade, sch.grading).levels,
  }));
  const due = [...new Set(prepared.map(x => x.a.due_on).filter(Boolean))].sort()[0];
  const several = tabs.length > 1;
  const wb = await sheets.createWorkbook(sch.google_refresh_token, {
    title,
    tabs,
    shareWith: prepared[0].a.staff?.email,
    message: `Please enter the scores for ${several ? `these ${tabs.length} learning areas` : `"${prepared[0].a.title}"`}.`
      + (several ? ` There is one tab for each (see the tabs at the bottom of the sheet): ${tabs.map(t => t.title).join('; ')}.` : '')
      + ` Row 2 shows what each column is out of: change it if your test was marked out of something else (e.g. 50).`
      + ` Type the marks, or AB where a learner was absent. The % and CBC level fill in by themselves. Your changes save automatically.`
      + (due ? ` Please finish by ${longDate(due)}.` : ''),
  });
  const sent = [];
  for (const [i, { a, learners }] of prepared.entries()) {
    sent.push(must(await db().from('assessments').update({
      sheet_id: wb.spreadsheetId, sheet_url: `${wb.url}#gid=${wb.tabs[i].sheetId}`, sheet_tab: wb.tabs[i].title,
      status: 'sheet_ready', sheet_learners: learners.map(l => l.id),
    }).eq('id', a.id).select(ASSESSMENT_SELECT).single()));
  }
  return { sent, skipped };
}

// Workbook title: the assessment's own title when there is one tab, else teacher + what it is.
function workbookTitle(sch, list, body = {}) {
  const school = sch.short_name || sch.name;
  if (list.length === 1) return `${school} - ${list[0].title}`;
  const a = list[0];
  const when = [a.week ? `Week ${a.week}` : null, `Term ${a.term}`, a.year].filter(Boolean).join(' ');
  return `${school} - ${a.staff?.full_name || 'Teacher'} - ${(body.title || '').trim() || `${KINDS[a.kind] || 'Assessment'} ${when}`}`;
}

// Learners in the class who are not paid for the assessment's term (so not on sheets).
async function unpaidLearners(assessment) {
  const [learners, paid] = await Promise.all([
    db().from('learners').select('id, first_name, last_name').eq('class_id', assessment.class_id).eq('active', true).then(must),
    paidLearnerIds(assessment.school_id, assessment.year, assessment.term),
  ]);
  return learners.filter(l => !paid.has(l.id)).map(l => ({ id: l.id, name: `${l.first_name} ${l.last_name}` }));
}

// Puts paid-for learners who are not yet on an assessment's sheet at the bottom of it. Returns their names.
async function addMissingLearners(assessment, sch) {
  const [components, learners] = await Promise.all([loadComponents(assessment.id), loadClassLearners(assessment)]);
  const onSheet = new Set(assessment.sheet_learners || []);
  const missing = learners.filter(l => !onSheet.has(l.id));
  if (!missing.length) return [];
  await sheets.addLearnersToSheet(sch.google_refresh_token, assessment.sheet_id,
    { tab: assessment.sheet_tab || undefined, components, learners: missing, levels: scaleForGrade(assessment.classes.grade, sch.grading).levels });
  must(await db().from('assessments').update({ sheet_learners: [...onSheet, ...missing.map(l => l.id)] }).eq('id', assessment.id));
  return missing.map(l => `${l.first_name} ${l.last_name}`);
}

/**
 * Called after a payment: adds the newly paid learners to every teacher's sheet already sent for
 * their classes in the paid terms (closed terms are left alone). A sheet that cannot be updated
 * (e.g. Google is disconnected) is reported, not fatal; the assessment page offers to retry.
 */
async function addPaidLearnersToSheets(schoolId, learnerIds, periods) {
  const sch = await school(schoolId);
  if (!sch.google_refresh_token || !learnerIds.length) return { sheets: 0, errors: [] };
  const classes = [...new Set(must(await db().from('learners').select('class_id').in('id', learnerIds)).map(l => l.class_id).filter(Boolean))];
  if (!classes.length) return { sheets: 0, errors: [] };
  let updated = 0;
  const errors = [];
  for (const { year, term } of periods) {
    if (await termClosed(schoolId, year, term)) continue;
    const list = must(await db().from('assessments').select(ASSESSMENT_SELECT).eq('school_id', schoolId).eq('year', year).eq('term', term)
      .in('class_id', classes).in('status', ['sheet_ready', 'analysed']).not('sheet_id', 'is', null));
    for (const a of list) {
      try {
        if ((await addMissingLearners(a, sch)).length) updated++;
      } catch (err) {
        console.error('Could not add learners to sheet', a.id, err);
        errors.push(`${a.title}: ${err.message}`);
      }
    }
  }
  return { sheets: updated, errors };
}

// Applies "out of" marks (from row 2 of the sheet, or typed in the app) to the components.
async function applyMaxScores(components, maxScores = []) {
  const byId = new Map(maxScores.map(m => [m.component_id, Number(m.max_score)]));
  const out = [];
  for (const c of components) {
    const v = byId.get(c.id);
    if (v == null || v === Number(c.max_score)) { out.push(c); continue; }
    if (!Number.isFinite(v) || v <= 0 || v > 1000) throw new HttpError(422, `"Out of" for ${c.label} must be a number from 1 to 1000`);
    must(await db().from('assessment_components').update({ max_score: v }).eq('id', c.id));
    out.push({ ...c, max_score: v });
  }
  return out;
}

// The most recent analysed assessment for the same class and learning area, before this one.
async function previousResults(a) {
  const prev = must(await db().from('assessments').select('id')
    .eq('class_id', a.class_id).eq('learning_area_id', a.learning_area_id).eq('status', 'analysed').neq('id', a.id)
    .lte('assessed_on', a.assessed_on).order('assessed_on', { ascending: false }).order('created_at', { ascending: false }).limit(1));
  if (!prev.length) return { id: null, results: [] };
  return { id: prev[0].id, results: must(await db().from('results').select('learner_id, percent').eq('assessment_id', prev[0].id)) };
}

// A learner is entered when every mark is filled in (a number, or AB if absent); "partial" have only some.
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
    if (own.length && filled === own.length) entered++;
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

  // Creates one assessment per selected teacher assignment, then sends each teacher ONE workbook
  // (one email) with a tab per learning area and class.
  // Body: { assignment_ids, kind, term, year, week?, assessed_on?, due_on?, title?, per_strand,
  //         components: [{ label, max_score, strand_id?, sub_strand_id? }] — or { max_score } for a single total,
  //         components_by_assignment?: { [assignment_id]: components } — per-strand, several learning areas at once }
  ['POST', '/api/assessments', async ({ req }) => {
    const admin = await requireAdmin(req);
    const body = await readJson(req);
    const ids = body.assignment_ids || [];
    required(body, ['kind', 'year', 'term']);
    if (!ids.length) throw new HttpError(400, 'Choose at least one learning area');
    if (!KINDS[body.kind]) throw new HttpError(400, `kind must be one of: ${Object.keys(KINDS).join(', ')}`);
    const byAsg = body.components_by_assignment && typeof body.components_by_assignment === 'object' ? body.components_by_assignment : null;
    if (body.per_strand && ids.length > 1 && !byAsg) throw new HttpError(400, 'Give the strands for each learning area');
    if (await termClosed(admin.school_id, Number(body.year), Number(body.term))) throw new HttpError(400, `Term ${body.term} ${body.year} is closed`);

    // What is scored, for each assignment: its own strands, the shared list, or a single total.
    const componentsFor = id => {
      let list = byAsg && Array.isArray(byAsg[id]) ? byAsg[id] : Array.isArray(body.components) ? body.components : [];
      if (!body.per_strand && !list.length) list = [{ label: 'Total', max_score: body.max_score }];
      if (!list.length) throw new HttpError(400, 'Add at least one strand to assess for each learning area');
      if (list.length > 40) throw new HttpError(400, 'An assessment can have at most 40 strands');
      list.forEach((c, i) => {
        if (!c.label || !(Number(c.max_score) > 0) || Number(c.max_score) > 1000) throw new HttpError(400, `Strand ${i + 1} needs a name and a maximum score from 1 to 1000`);
      });
      return list;
    };
    const componentsOf = new Map(ids.map(id => [id, componentsFor(id)]));
    const term = Number(body.term);
    const year = Number(body.year);
    if (!(term >= 1 && term <= 3) || !Number.isInteger(year) || year < 2000 || year > 2100) throw new HttpError(400, 'Choose a valid term (1–3) and year');
    if (body.assessed_on && !/^\d{4}-\d{2}-\d{2}$/.test(body.assessed_on)) throw new HttpError(400, 'Date must look like 2027-03-27');
    if (body.due_on && !/^\d{4}-\d{2}-\d{2}$/.test(body.due_on)) throw new HttpError(400, 'The date to enter scores by must look like 2027-03-27');

    const assignments = must(await db().from('teacher_assignments').select('*, classes(*), learning_areas(*), staff(full_name, active)')
      .in('id', ids).eq('school_id', admin.school_id));
    if (assignments.length !== ids.length) throw new HttpError(404, 'Some learning area assignments were not found');
    const removed = assignments.filter(a => a.staff?.active === false);
    if (removed.length) {
      throw new HttpError(400, `${removed.map(a => `${a.learning_areas.name} (${a.staff.full_name})`).join(', ')}: this teacher has been removed. Assign the learning area to another teacher first (Teachers page).`);
    }
    const sch = await school(admin.school_id);

    const made = [];
    for (const asg of assignments) {
      const components = componentsOf.get(asg.id);
      const assessment = must(await db().from('assessments').insert({
        school_id: admin.school_id, assignment_id: asg.id, class_id: asg.class_id, learning_area_id: asg.learning_area_id,
        teacher_id: asg.teacher_id,
        title: (assignments.length === 1 && body.title?.trim()) || defaultTitle({ cls: asg.classes, area: asg.learning_areas, ...body }),
        kind: body.kind, per_strand: Boolean(body.per_strand), term: Number(body.term), year: Number(body.year),
        week: body.week ? Number(body.week) : null, assessed_on: body.assessed_on || new Date().toISOString().slice(0, 10),
        due_on: body.due_on || null,
      }).select(ASSESSMENT_SELECT).single());
      must(await db().from('assessment_components').insert(components.map((c, i) => ({
        assessment_id: assessment.id, strand_id: c.strand_id || null, sub_strand_id: c.sub_strand_id || null,
        label: String(c.label).trim(), max_score: Number(c.max_score), sort_order: i,
      }))));
      made.push(assessment);
    }
    if (!sch.google_refresh_token) {
      return { created: made.map(assessment => ({ assessment, note: 'Saved as a draft; connect Google in Settings to send the sheet' })), workbooks: 0 };
    }
    // One workbook per teacher.
    const result = new Map();
    let workbooks = 0;
    const byTeacher = new Map();
    for (const a of made) {
      if (!byTeacher.has(a.teacher_id)) byTeacher.set(a.teacher_id, []);
      byTeacher.get(a.teacher_id).push(a);
    }
    for (const list of byTeacher.values()) {
      try {
        const { sent, skipped } = await generateWorkbook(list, sch, workbookTitle(sch, list, body));
        if (sent.length) workbooks++;
        for (const a of sent) result.set(a.id, { assessment: a });
        for (const x of skipped) result.set(x.assessment.id, x);
      } catch (err) {
        console.error('Workbook generation failed', err);
        for (const a of list) result.set(a.id, { assessment: a, note: `Saved, but the sheet could not be created: ${err.message}` });
      }
    }
    return { created: made.map(a => result.get(a.id)), workbooks };
  }],

  // The assessment, its strands, results, and (for typing scores in the app) the learners and saved scores.
  ['GET', '/api/assessments/:id', async ({ req, params }) => {
    const admin = await requireAdmin(req);
    const assessment = await loadAssessment(params.id, admin);
    const [components, results, learners, scores] = await Promise.all([
      loadComponents(assessment.id),
      db().from('results').select('*, learners(id, adm_no, first_name, last_name)').eq('assessment_id', assessment.id).then(must),
      loadClassLearners(assessment),
      db().from('scores').select('learner_id, component_id, raw_score, absent, comment').eq('assessment_id', assessment.id).then(must),
    ]);
    results.sort((a, b) => `${a.learners.first_name} ${a.learners.last_name}`.localeCompare(`${b.learners.first_name} ${b.learners.last_name}`));
    const onSheet = new Set(assessment.sheet_learners || []);
    return {
      assessment, components, results, learners, scores,
      term_closed: await termClosed(admin.school_id, assessment.year, assessment.term),
      // Not paid for this term: left off the sheet until paid for.
      unpaid: await unpaidLearners(assessment),
      // Paid for after the sheet was sent: can be added to it.
      not_on_sheet: assessment.sheet_id ? learners.filter(l => !onSheet.has(l.id)).map(l => ({ id: l.id, name: `${l.first_name} ${l.last_name}` })) : [],
    };
  }],

  // (Re)generates the sheet, e.g. after connecting Google or adding learners.
  ['POST', '/api/assessments/:id/sheet', async ({ req, params }) => {
    const admin = await requireAdmin(req);
    const assessment = await loadAssessment(params.id, admin);
    if (assessment.status === 'analysed') throw new HttpError(400, 'This assessment is already analysed');
    const sch = await school(admin.school_id);
    const { sent, skipped } = await generateWorkbook([assessment], sch, workbookTitle(sch, [assessment]));
    if (!sent.length) throw new HttpError(400, skipped[0].note.replace('Saved, but not sent: t', 'T'));
    return { assessment: sent[0] };
  }],

  // Adds learners paid for after the sheet was sent to the bottom of the teacher's sheet.
  ['POST', '/api/assessments/:id/sheet/learners', async ({ req, params }) => {
    const admin = await requireAdmin(req);
    const assessment = await loadAssessment(params.id, admin);
    if (!assessment.sheet_id) throw new HttpError(400, 'This assessment has no sheet yet');
    if (assessment.status === 'analysed' && await termClosed(admin.school_id, assessment.year, assessment.term)) throw new HttpError(400, 'This term is closed');
    const missing = await addMissingLearners(assessment, await school(admin.school_id));
    return { added: missing.length, learners: missing };
  }],

  ['GET', '/api/assessments/:id/progress', async ({ req, params }) => {
    const admin = await requireAdmin(req);
    const assessment = await loadAssessment(params.id, admin);
    if (!assessment.sheet_id) throw new HttpError(400, 'This assessment has no sheet yet');
    const [components, learners, sch] = await Promise.all([loadComponents(assessment.id), loadClassLearners(assessment), school(admin.school_id)]);
    const values = await sheets.readAssessmentSheet(sch.google_refresh_token, assessment.sheet_id, assessment.sheet_tab || undefined);
    const { scores, issues, outOfErrors } = sheets.parseSheetValues(values, components, learners);
    return { ...sheetProgress(scores, learners), issues: [...issues, ...(outOfErrors || [])] };
  }],

  ['DELETE', '/api/assessments/:id', async ({ req, params }) => {
    const admin = await requireAdmin(req);
    const assessment = await loadAssessment(params.id, admin);
    if (await termClosed(admin.school_id, assessment.year, assessment.term)) throw new HttpError(400, `Term ${assessment.term} ${assessment.year} is closed`);
    must(await db().from('assessments').delete().eq('id', assessment.id));
  }],

  // Reads the sheet (or body.scores when scores are typed in the app), validates and analyses.
  ['POST', '/api/assessments/:id/analyse', async ({ req, params }) => {
    const admin = await requireAdmin(req);
    const assessment = await loadAssessment(params.id, admin);
    if (await termClosed(admin.school_id, assessment.year, assessment.term)) {
      throw new HttpError(400, `Term ${assessment.term} ${assessment.year} is closed; reopen it to change results`);
    }
    const body = await readJson(req);
    let [components, learners, sch] = await Promise.all([loadComponents(assessment.id), loadClassLearners(assessment), school(admin.school_id)]);

    let scores;
    let issues = [];
    let maxScores = Array.isArray(body.max_scores) ? body.max_scores : [];
    if (Array.isArray(body.scores)) {
      const comps = new Set(components.map(c => c.id));
      scores = body.scores.filter(s => comps.has(s.component_id)).map(s => {
        const text = s.raw_score == null ? '' : String(s.raw_score).trim();
        const absent = Boolean(s.absent) || /^ab$/i.test(text);
        return {
          learner_id: s.learner_id, component_id: s.component_id, absent,
          raw_score: absent ? 'AB' : text === '' ? null : text,
          comment: null,
        };
      });
    } else {
      if (!assessment.sheet_id) throw new HttpError(400, 'This assessment has no sheet yet');
      if (!sch.google_refresh_token) throw new HttpError(400, 'Google account is not connected');
      const values = await sheets.readAssessmentSheet(sch.google_refresh_token, assessment.sheet_id, assessment.sheet_tab || undefined);
      let outOfErrors;
      ({ scores, issues, maxScores, outOfErrors } = sheets.parseSheetValues(values, components, learners));
      if (!scores.length && issues.length) throw new HttpError(422, 'The sheet layout was changed', issues);
      if (outOfErrors.length) throw new HttpError(422, 'Fix the "Out of" row (row 2) in the sheet', outOfErrors);
    }
    // What each column is out of: percentages are worked out from it.
    components = await applyMaxScores(components, maxScores);

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

module.exports = { routes, KINDS, classLabel, sheetProgress, addPaidLearnersToSheets };
