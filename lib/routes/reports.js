// Term results: the class teacher's sheet, learners' termly report forms (with drafted,
// editable class and head teacher comments), and term dates / closing a term.
// End-of-year results: the same for the whole year (Term 1, 2, 3 and the year average).
// Year comments are stored with term = 0.

const { db, must, one } = require('../db');
const { HttpError, readJson, required } = require('../http');
const { requireAdmin } = require('../auth');
const { scaleForGrade, gradeLabel } = require('../cbc');
const { buildTerm, buildYear, draftClassComment, draftHeadComment } = require('../term');
const { paidLearnerIds } = require('../billing');
const { publicSchool } = require('./setup');

function parsePeriod(q) {
  const year = Number(q.year);
  const term = Number(q.term);
  if (!Number.isInteger(year) || !(term >= 1 && term <= 3)) throw new HttpError(400, 'Choose a year and a term (1–3)');
  return { year, term };
}

function parseYear(q) {
  const year = Number(q.year);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new HttpError(400, 'Choose a year');
  return year;
}

async function termRecord(schoolId, year, term) {
  return must(await db().from('terms').select('*').eq('school_id', schoolId).eq('year', year).eq('term', term).maybeSingle())
    || { year, term, closing_date: null, next_term_date: null, closed_at: null };
}

const LEARNER_FIELDS = 'id, adm_no, assessment_no, first_name, last_name, gender';

// Everything needed for a class's term: class, school, learners, results and comments.
// Learners are those paid for the term who are in the class now, plus anyone with results
// in the class that term (so old report forms still print after promotion or a move).
async function loadClass(admin, classId) {
  return one(await db().from('classes').select('id, grade, stream, year, staff!classes_class_teacher_id_fkey(id, full_name)')
    .eq('id', classId).eq('school_id', admin.school_id).maybeSingle(), 'Class');
}

async function loadTerm(admin, classId, { year, term }, preloaded = {}) {
  const cls = preloaded.cls || await loadClass(admin, classId);
  const [sch, assessments, current, paid] = await Promise.all([
    preloaded.sch || db().from('schools').select('*').eq('id', admin.school_id).single().then(must),
    db().from('assessments').select('id, learning_area_id, kind, per_strand, assessed_on, title, learning_areas(name, code), staff!assessments_teacher_id_fkey(full_name)')
      .eq('school_id', admin.school_id).eq('class_id', cls.id).eq('year', year).eq('term', term).eq('status', 'analysed').order('assessed_on').then(must),
    db().from('learners').select(LEARNER_FIELDS).eq('class_id', cls.id).eq('active', true).then(must),
    paidLearnerIds(admin.school_id, year, term),
  ]);
  const ids = assessments.map(a => a.id);
  const style = sch.assessment_style === 'strands' ? 'strands' : 'exams';
  const [results, comments, components] = ids.length
    ? await Promise.all([
      db().from('results').select('assessment_id, learner_id, status, percent, strands').in('assessment_id', ids).then(must),
      db().from('scores').select('assessment_id, learner_id, comment').in('assessment_id', ids).not('comment', 'is', null).then(must),
      style === 'strands'
        ? db().from('assessment_components').select('id, assessment_id, label, strands(name, sort_order)').in('assessment_id', ids).then(must)
        : [],
    ])
    : [[], [], []];
  const withResults = new Set(results.map(r => r.learner_id));
  const missing = [...withResults].filter(id => !current.some(l => l.id === id));
  const former = missing.length
    ? must(await db().from('learners').select(LEARNER_FIELDS).in('id', missing).eq('school_id', admin.school_id))
    : [];
  const learners = [...current.filter(l => paid.has(l.id) || withResults.has(l.id)), ...former]
    .sort((a, b) => `${a.first_name} ${a.last_name}`.localeCompare(`${b.first_name} ${b.last_name}`));
  const scale = scaleForGrade(cls.grade, sch.grading);
  const data = buildTerm({ learners, assessments, results, comments, scale, style, components });
  return { cls, sch, scale, data, learners };
}

// The whole year: each term's results, combined (learners with results in any term).
async function loadYear(admin, classId, year) {
  const cls = await loadClass(admin, classId);
  const sch = must(await db().from('schools').select('*').eq('id', admin.school_id).single());
  const terms = await Promise.all([1, 2, 3].map(term => loadTerm(admin, classId, { year, term }, { cls, sch })));
  const learners = new Map();
  for (const t of terms) for (const l of t.learners) learners.set(l.id, l);
  const list = [...learners.values()].sort((a, b) => `${a.first_name} ${a.last_name}`.localeCompare(`${b.first_name} ${b.last_name}`));
  const scale = terms[0].scale;
  const data = buildYear(terms.map((t, i) => ({ term: i + 1, data: t.data })), list, scale);
  return { cls, sch, scale, data };
}

async function savedComments(schoolId, year, term, rows) {
  const saved = rows.length
    ? must(await db().from('report_comments').select('*').eq('school_id', schoolId).eq('year', year).eq('term', term)
      .in('learner_id', rows.map(r => r.learner_id)))
    : [];
  return new Map(saved.map(c => [c.learner_id, c]));
}

const withComments = (rows, savedOf, scale, period) => rows.map(r => {
  const c = savedOf.get(r.learner_id) || {};
  return {
    ...r,
    class_comment: c.class_comment ?? draftClassComment(r, scale, period),
    head_comment: c.head_comment ?? draftHeadComment(r, scale, period),
    co_curricular: c.co_curricular ?? '',
    comments_saved: Boolean(savedOf.get(r.learner_id)),
  };
});

const classInfo = cls => ({ id: cls.id, grade: cls.grade, stream: cls.stream, year: cls.year,
  label: `${gradeLabel(cls.grade)}${cls.stream ? ' ' + cls.stream : ''}`, class_teacher: cls.staff?.full_name || null });

const routes = [
  // The class teacher's sheet: every learner's term average per learning area, with class means.
  ['GET', '/api/classes/:id/term', async ({ req, params, query }) => {
    const admin = await requireAdmin(req);
    const period = parsePeriod(query);
    const { cls, data } = await loadTerm(admin, params.id, period);
    return { class: classInfo(cls), ...period, term_record: await termRecord(admin.school_id, period.year, period.term), ...data };
  }],

  // Termly report forms: ?class_id=…&year=…&term=…[&learner_id=…]
  ['GET', '/api/reports/termly', async ({ req, query }) => {
    const admin = await requireAdmin(req);
    const period = parsePeriod(query);
    if (!query.class_id) throw new HttpError(400, 'Choose a class');
    const { cls, sch, scale, data } = await loadTerm(admin, query.class_id, period);
    const rows = query.learner_id ? data.learners.filter(r => r.learner_id === query.learner_id) : data.learners;
    const savedOf = await savedComments(admin.school_id, period.year, period.term, rows);
    return {
      school: publicSchool(sch),
      class: classInfo(cls),
      ...period,
      style: data.style,
      term_record: await termRecord(admin.school_id, period.year, period.term),
      columns: data.columns,
      areas: data.areas.map(a => ({ id: a.id, name: a.name, ...(a.strands ? { strands: a.strands } : {}) })),
      reports: withComments(rows, savedOf, scale, 'term'),
    };
  }],

  // The class sheet for the whole year: each learner's Term 1, 2, 3 and year average per learning area.
  ['GET', '/api/classes/:id/year', async ({ req, params, query }) => {
    const admin = await requireAdmin(req);
    const year = parseYear(query);
    const { cls, data } = await loadYear(admin, params.id, year);
    return { class: classInfo(cls), year, ...data };
  }],

  // End-of-year report forms: ?class_id=…&year=…[&learner_id=…]. Dates and closing follow Term 3.
  ['GET', '/api/reports/annual', async ({ req, query }) => {
    const admin = await requireAdmin(req);
    const year = parseYear(query);
    if (!query.class_id) throw new HttpError(400, 'Choose a class');
    const { cls, sch, scale, data } = await loadYear(admin, query.class_id, year);
    const rows = query.learner_id ? data.learners.filter(r => r.learner_id === query.learner_id) : data.learners;
    const savedOf = await savedComments(admin.school_id, year, 0, rows);
    return {
      school: publicSchool(sch),
      class: classInfo(cls),
      year,
      term: 0,
      terms: data.terms,
      term_record: await termRecord(admin.school_id, year, 3),
      areas: data.areas.map(a => ({ id: a.id, name: a.name })),
      reports: withComments(rows, savedOf, scale, 'year'),
    };
  }],

  // Saves the class and head teacher comments (and co-curricular note) for one learner's report.
  ['PUT', '/api/report-comments', async ({ req }) => {
    const admin = await requireAdmin(req);
    const body = await readJson(req);
    required(body, ['learner_id', 'year', 'term']);
    // term 0 is the end-of-year report; it is locked when Term 3 is closed.
    const annual = Number(body.term) === 0;
    if (annual) parseYear(body); else parsePeriod(body);
    one(await db().from('learners').select('id').eq('id', body.learner_id).eq('school_id', admin.school_id).maybeSingle(), 'Learner');
    const t = await termRecord(admin.school_id, Number(body.year), annual ? 3 : Number(body.term));
    if (t.closed_at) throw new HttpError(400, `${annual ? 'Term 3' : 'This term'} is closed; reopen it to change comments`);
    const clip = v => (v == null ? null : String(v).slice(0, 600));
    return must(await db().from('report_comments').upsert({
      school_id: admin.school_id, learner_id: body.learner_id, year: Number(body.year), term: Number(body.term),
      class_comment: clip(body.class_comment), head_comment: clip(body.head_comment), co_curricular: clip(body.co_curricular),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'learner_id,year,term' }).select().single());
  }],

  // Term dates printed on the report forms. Body: { year, term, closing_date, next_term_date }
  ['PUT', '/api/terms', async ({ req }) => {
    const admin = await requireAdmin(req);
    const body = await readJson(req);
    const { year, term } = parsePeriod(body);
    const existing = await termRecord(admin.school_id, year, term);
    if (existing.closed_at) throw new HttpError(400, 'This term is closed; reopen it to change its dates');
    for (const d of [body.closing_date, body.next_term_date]) {
      if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new HttpError(400, 'Dates must look like 2027-04-02');
    }
    return must(await db().from('terms').upsert({
      school_id: admin.school_id, year, term, closing_date: body.closing_date || null, next_term_date: body.next_term_date || null,
    }, { onConflict: 'school_id,year,term' }).select().single());
  }],

  // Closing a term locks its results and comments, so printed reports stay final.
  ['POST', '/api/terms/close', async ({ req }) => {
    const admin = await requireAdmin(req);
    const { year, term } = parsePeriod(await readJson(req));
    return must(await db().from('terms').upsert({ school_id: admin.school_id, year, term, closed_at: new Date().toISOString() },
      { onConflict: 'school_id,year,term' }).select().single());
  }],

  ['POST', '/api/terms/reopen', async ({ req }) => {
    const admin = await requireAdmin(req);
    const { year, term } = parsePeriod(await readJson(req));
    return must(await db().from('terms').upsert({ school_id: admin.school_id, year, term, closed_at: null },
      { onConflict: 'school_id,year,term' }).select().single());
  }],
];

module.exports = { routes };
