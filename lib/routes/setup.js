// School setup: school details, classes, staff (admins and teachers), learners, teacher assignments.

const { db, must, one } = require('../db');
const { HttpError, readJson, required } = require('../http');
const { authUser, findStaff, isOwner, requireAdmin } = require('../auth');
const { normalizeKenyanPhone } = require('../phone');
const { SCALES } = require('../cbc');
const { currentPeriod } = require('../billing');

// Never send the school's Google token to the browser.
function publicSchool(s) {
  if (!s) return null;
  const { google_refresh_token, ...rest } = s;
  return { ...rest, google_connected: Boolean(google_refresh_token) };
}

const pick = (obj, keys) => Object.fromEntries(keys.filter(k => obj[k] !== undefined).map(k => [k, obj[k]]));
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const MAX_LEARNERS_PER_UPLOAD = 2000;

function validGrade(g) {
  const n = Number(g);
  if (!Number.isInteger(n) || n < -1 || n > 12) throw new HttpError(400, 'Grade must be PP1, PP2 or 1–12');
  return n;
}

function validYear(y) {
  const n = Number(y);
  if (!Number.isInteger(n) || n < 2000 || n > 2100) throw new HttpError(400, 'Enter a valid year');
  return n;
}

// Threshold overrides must keep each scale's levels in order (EE above ME above AE …).
function validateGrading(grading) {
  if (!grading || typeof grading !== 'object') throw new HttpError(400, 'grading must be an object');
  for (const [id, overrides] of Object.entries(grading)) {
    const base = SCALES[id];
    if (!base) throw new HttpError(400, `Unknown grading scale: ${id}`);
    const mins = base.levels.map(l => (overrides[l.code] != null ? Number(overrides[l.code]) : l.min));
    mins[mins.length - 1] = 0;
    if (mins.some(m => !Number.isFinite(m) || m < 0 || m > 100)) throw new HttpError(400, 'Thresholds must be between 0 and 100');
    for (let i = 1; i < mins.length; i++) {
      if (mins[i] >= mins[i - 1]) throw new HttpError(400, `${base.levels[i - 1].code} must be higher than ${base.levels[i].code}`);
    }
  }
}

const SCHOOL_FIELDS = ['name', 'short_name', 'county', 'address', 'phone', 'email', 'motto', 'head_teacher_name', 'grading', 'logo'];

// The logo is stored as a small image data URL (the browser resizes it before upload).
const LOGO_MAX_CHARS = 400 * 1024;
function validateLogo(logo) {
  if (logo === null || logo === '') return null;
  if (typeof logo !== 'string' || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(logo)) {
    throw new HttpError(400, 'The logo must be a PNG, JPEG or WEBP image');
  }
  if (logo.length > LOGO_MAX_CHARS) throw new HttpError(400, 'The logo is too large; use a smaller image');
  return logo;
}

const routes = [
  ['GET', '/api/config', async () => ({ supabaseUrl: process.env.SUPABASE_URL, supabaseAnonKey: process.env.SUPABASE_ANON_KEY })],

  ['GET', '/api/me', async ({ req }) => {
    const user = await authUser(req);
    const staff = await findStaff(user);
    const school = staff ? must(await db().from('schools').select('*').eq('id', staff.school_id).single()) : null;
    return { user: { id: user.id, email: user.email }, is_owner: isOwner(user), staff, school: publicSchool(school) };
  }],

  // First sign-in by a head teacher or admin: register the school.
  ['POST', '/api/schools', async ({ req }) => {
    const user = await authUser(req);
    if (await findStaff(user)) throw new HttpError(409, 'You already belong to a school');
    const body = await readJson(req);
    required(body, ['name', 'full_name']);
    if (!String(body.name).trim() || !String(body.full_name).trim()) throw new HttpError(400, 'School name and your name are required');
    const school = must(await db().from('schools').insert({
      ...pick(body, ['county', 'address', 'phone', 'email', 'motto', 'head_teacher_name']),
      name: body.name.trim(),
      short_name: (body.short_name || body.name).trim().slice(0, 30),
    }).select().single());
    const staff = must(await db().from('staff').insert({
      school_id: school.id, user_id: user.id, full_name: body.full_name.trim(),
      email: user.email.toLowerCase(), phone: body.phone || null, role: 'admin',
    }).select().single());
    return { school: publicSchool(school), staff };
  }],

  ['PATCH', '/api/school', async ({ req }) => {
    const admin = await requireAdmin(req);
    const body = pick(await readJson(req), SCHOOL_FIELDS);
    if (body.grading !== undefined) validateGrading(body.grading);
    if (body.logo !== undefined) body.logo = validateLogo(body.logo);
    if (body.name !== undefined && !String(body.name).trim()) throw new HttpError(400, 'School name is required');
    return { school: publicSchool(must(await db().from('schools').update(body).eq('id', admin.school_id).select().single())) };
  }],

  // Progress through first-time setup, for the "Getting started" checklist.
  ['GET', '/api/setup-status', async ({ req }) => {
    const admin = await requireAdmin(req);
    const id = admin.school_id;
    const now = currentPeriod();
    const [school, classes, learners, staff, assignments, paid, assessments] = await Promise.all([
      db().from('schools').select('address, phone, head_teacher_name, google_refresh_token').eq('id', id).single().then(must),
      db().from('classes').select('id').eq('school_id', id).then(must),
      db().from('learners').select('id').eq('school_id', id).eq('active', true).then(must),
      db().from('staff').select('id').eq('school_id', id).eq('role', 'teacher').eq('active', true).then(must),
      db().from('teacher_assignments').select('id').eq('school_id', id).then(must),
      db().from('learner_terms').select('learner_id').eq('school_id', id).eq('year', now.year).eq('term', now.term).then(must),
      db().from('assessments').select('id, status').eq('school_id', id).then(must),
    ]);
    const steps = [
      { key: 'details', done: Boolean(school.head_teacher_name && (school.address || school.phone)), link: '#settings', label: "Add the school's details (printed on report forms)" },
      { key: 'google', done: Boolean(school.google_refresh_token), link: '#settings', label: "Connect the school's Google account" },
      { key: 'classes', done: classes.length > 0, link: '#classes', label: 'Add your classes' },
      { key: 'learners', done: learners.length > 0, link: '#classes', label: 'Add learners to each class' },
      { key: 'paid', done: learners.length > 0 && paid.length > 0, link: '#settings', label: `Pay for learners for Term ${now.term}` },
      { key: 'teachers', done: staff.length > 0, link: '#teachers', label: 'Add your teachers (with their Gmail)' },
      { key: 'assignments', done: assignments.length > 0, link: '#teachers', label: 'Say who teaches which learning area' },
      { key: 'assessment', done: assessments.length > 0, link: '#new', label: 'Create your first assessment' },
      { key: 'analysed', done: assessments.some(a => a.status === 'analysed'), link: '#dashboard', label: 'Analyse it once the teacher has filled the sheet' },
    ];
    return { steps, done: steps.every(s => s.done) };
  }],

  // Classes
  ['GET', '/api/classes', async ({ req }) => {
    const admin = await requireAdmin(req);
    return must(await db().from('classes').select('*, learners(count), staff!classes_class_teacher_id_fkey(id, full_name)')
      .eq('school_id', admin.school_id).order('year', { ascending: false }).order('grade').order('stream'));
  }],

  ['POST', '/api/classes', async ({ req }) => {
    const admin = await requireAdmin(req);
    const body = await readJson(req);
    required(body, ['grade', 'year']);
    if (body.class_teacher_id) one(await db().from('staff').select('id').eq('id', body.class_teacher_id).eq('school_id', admin.school_id).maybeSingle(), 'Teacher');
    return must(await db().from('classes').insert({
      school_id: admin.school_id, grade: validGrade(body.grade), stream: String(body.stream || '').trim().slice(0, 30) || null,
      year: validYear(body.year), class_teacher_id: body.class_teacher_id || null,
    }).select().single());
  }],

  ['PATCH', '/api/classes/:id', async ({ req, params }) => {
    const admin = await requireAdmin(req);
    const body = pick(await readJson(req), ['stream', 'class_teacher_id']);
    if (body.class_teacher_id === '') body.class_teacher_id = null;
    if (body.class_teacher_id) one(await db().from('staff').select('id').eq('id', body.class_teacher_id).eq('school_id', admin.school_id).maybeSingle(), 'Teacher');
    return one(await db().from('classes').update(body).eq('id', params.id).eq('school_id', admin.school_id).select().maybeSingle(), 'Class');
  }],

  ['DELETE', '/api/classes/:id', async ({ req, params }) => {
    const admin = await requireAdmin(req);
    must(await db().from('classes').delete().eq('id', params.id).eq('school_id', admin.school_id));
  }],

  // Staff: admins sign in (e.g. the head teacher and the ICT person); teachers only receive sheets.
  ['GET', '/api/staff', async ({ req }) => {
    const admin = await requireAdmin(req);
    return must(await db().from('staff').select('id, full_name, email, phone, role, active, user_id')
      .eq('school_id', admin.school_id).order('full_name'));
  }],

  ['POST', '/api/staff', async ({ req }) => {
    const admin = await requireAdmin(req);
    const body = await readJson(req);
    required(body, ['full_name', 'email']);
    const email = String(body.email).trim().toLowerCase();
    if (!EMAIL.test(email)) throw new HttpError(400, 'Enter a valid email address');
    if (!String(body.full_name).trim()) throw new HttpError(400, 'Name is required');
    const staff = must(await db().from('staff').insert({
      school_id: admin.school_id, full_name: body.full_name.trim(), email,
      phone: body.phone || null, role: body.role === 'admin' ? 'admin' : 'teacher',
    }).select().single());
    if (staff.role !== 'admin') return { staff, invited: false };
    const { error } = await db().auth.admin.inviteUserByEmail(email, { redirectTo: `${process.env.APP_URL}/app.html` });
    return { staff, invited: !error };
  }],

  // Edit a teacher or admin, or remove them (active: false) when they leave.
  ['PATCH', '/api/staff/:id', async ({ req, params }) => {
    const admin = await requireAdmin(req);
    const body = pick(await readJson(req), ['full_name', 'email', 'phone', 'role', 'active']);
    if (params.id === admin.id && (body.active === false || body.role === 'teacher')) throw new HttpError(400, 'You cannot remove your own admin access');
    if (body.full_name !== undefined && !String(body.full_name).trim()) throw new HttpError(400, 'Name is required');
    if (body.full_name !== undefined) body.full_name = String(body.full_name).trim();
    if (body.role !== undefined && !['admin', 'teacher'].includes(body.role)) throw new HttpError(400, 'Role must be admin or teacher');
    if (body.active !== undefined) body.active = Boolean(body.active);
    if (body.phone !== undefined) body.phone = String(body.phone || '').trim() || null;
    const current = one(await db().from('staff').select('id, email, user_id').eq('id', params.id).eq('school_id', admin.school_id).maybeSingle(), 'Staff member');
    if (body.email !== undefined) {
      body.email = String(body.email || '').trim().toLowerCase();
      if (!EMAIL.test(body.email)) throw new HttpError(400, 'Enter a valid email address');
      // A new email is a different sign-in account: the old one stops working for this person.
      if (body.email !== current.email) body.user_id = null;
    }
    return one(await db().from('staff').update(body).eq('id', current.id).eq('school_id', admin.school_id)
      .select('id, full_name, email, phone, role, active').maybeSingle(), 'Staff member');
  }],

  // Learners
  ['GET', '/api/learners', async ({ req, query }) => {
    const admin = await requireAdmin(req);
    let q = db().from('learners').select('*').eq('school_id', admin.school_id).eq('active', true);
    if (query.class_id) q = q.eq('class_id', query.class_id);
    return must(await q.order('first_name').order('last_name'));
  }],

  // Body: { class_id, learners: [{ adm_no, assessment_no, first_name, last_name, gender, parent_name, parent_phone }] }
  // Existing ADM numbers are updated (e.g. moved to a new class). Nothing is charged here:
  // the admin then pays for the new learners by the term or the year (routes/billing.js).
  ['POST', '/api/learners', async ({ req }) => {
    const admin = await requireAdmin(req);
    const body = await readJson(req);
    required(body, ['class_id', 'learners']);
    if (!Array.isArray(body.learners) || !body.learners.length) throw new HttpError(400, 'Add at least one learner');
    if (body.learners.length > MAX_LEARNERS_PER_UPLOAD) throw new HttpError(400, `Add at most ${MAX_LEARNERS_PER_UPLOAD} learners at a time`);
    const cls = one(await db().from('classes').select('id, year').eq('id', body.class_id).eq('school_id', admin.school_id).maybeSingle(), 'Class');
    const problems = [];
    const rows = body.learners.map((l, i) => {
      if (!l.first_name || !l.last_name) problems.push(`Row ${i + 1}: first and last name are required`);
      const phone = l.parent_phone ? normalizeKenyanPhone(l.parent_phone) : null;
      if (l.parent_phone && !phone) problems.push(`Row ${i + 1}: "${l.parent_phone}" is not a valid Kenyan phone number`);
      const g = String(l.gender || '').trim().toUpperCase()[0];
      return {
        school_id: admin.school_id, class_id: cls.id,
        adm_no: l.adm_no ? String(l.adm_no).trim() : null,
        assessment_no: l.assessment_no ? String(l.assessment_no).trim() : null,
        first_name: String(l.first_name || '').trim(), last_name: String(l.last_name || '').trim(),
        gender: g === 'F' || g === 'M' ? g : null,
        parent_name: l.parent_name || null, parent_phone: phone, active: true,
      };
    });
    if (problems.length) throw new HttpError(400, 'Fix these rows and try again', problems);
    const withAdm = rows.filter(r => r.adm_no);
    const withoutAdm = rows.filter(r => !r.adm_no);
    const existing = withAdm.length
      ? must(await db().from('learners').select('id, adm_no').eq('school_id', admin.school_id).in('adm_no', withAdm.map(r => r.adm_no)))
      : [];
    const existingAdm = new Set(existing.map(e => e.adm_no));
    const saved = [];
    if (withAdm.length) saved.push(...must(await db().from('learners').upsert(withAdm, { onConflict: 'school_id,adm_no' }).select()));
    if (withoutAdm.length) saved.push(...must(await db().from('learners').insert(withoutAdm).select()));
    const added = saved.filter(l => !l.adm_no || !existingAdm.has(l.adm_no));
    return { saved: saved.length, added: added.length, added_ids: added.map(l => l.id), learners: saved };
  }],

  // Edit a learner, move them to another class (class_id), or remove them (active: false).
  ['PATCH', '/api/learners/:id', async ({ req, params }) => {
    const admin = await requireAdmin(req);
    const body = pick(await readJson(req), ['class_id', 'adm_no', 'assessment_no', 'first_name', 'last_name', 'gender', 'parent_name', 'parent_phone', 'active']);
    if (body.class_id) one(await db().from('classes').select('id').eq('id', body.class_id).eq('school_id', admin.school_id).maybeSingle(), 'Class');
    for (const k of ['first_name', 'last_name']) {
      if (body[k] !== undefined && !String(body[k]).trim()) throw new HttpError(400, 'First and last name are required');
      if (body[k] !== undefined) body[k] = String(body[k]).trim();
    }
    for (const k of ['adm_no', 'assessment_no', 'parent_name']) if (body[k] !== undefined) body[k] = String(body[k] || '').trim() || null;
    if (body.gender !== undefined) {
      const g = String(body.gender || '').trim().toUpperCase()[0];
      body.gender = g === 'F' || g === 'M' ? g : null;
    }
    if (body.parent_phone !== undefined) {
      const raw = String(body.parent_phone || '').trim();
      body.parent_phone = raw ? normalizeKenyanPhone(raw) : null;
      if (raw && !body.parent_phone) throw new HttpError(400, 'Invalid Kenyan phone number');
    }
    if (body.active !== undefined) body.active = Boolean(body.active);
    return one(await db().from('learners').update(body).eq('id', params.id).eq('school_id', admin.school_id).select().maybeSingle(), 'Learner');
  }],

  // Start of a new year: move every learner in the class up a grade (same stream, next year),
  // creating that class if needed. Body: { mode: 'promote' } or { mode: 'complete' } for a
  // final-year class whose learners have finished (they are kept, but no longer active).
  // Their results and old report forms stay available under the old class.
  ['POST', '/api/classes/:id/promote', async ({ req, params }) => {
    const admin = await requireAdmin(req);
    const { mode } = await readJson(req);
    const cls = one(await db().from('classes').select('*').eq('id', params.id).eq('school_id', admin.school_id).maybeSingle(), 'Class');
    const learners = must(await db().from('learners').select('id').eq('class_id', cls.id).eq('active', true));
    if (!learners.length) throw new HttpError(400, 'This class has no learners to move');
    const ids = learners.map(l => l.id);
    if (mode === 'complete') {
      must(await db().from('learners').update({ active: false }).in('id', ids).eq('school_id', admin.school_id));
      return { completed: ids.length };
    }
    if (mode !== 'promote') throw new HttpError(400, 'mode must be promote or complete');
    if (cls.grade >= 12) throw new HttpError(400, 'There is no grade after Grade 12');
    const target = { school_id: admin.school_id, grade: cls.grade + 1, stream: cls.stream || null, year: cls.year + 1 };
    let next = must(await db().from('classes').select('*').eq('school_id', target.school_id).eq('grade', target.grade)
      .eq('year', target.year)[cls.stream ? 'eq' : 'is']('stream', cls.stream || null).maybeSingle());
    if (!next) next = must(await db().from('classes').insert(target).select().single());
    must(await db().from('learners').update({ class_id: next.id }).in('id', ids).eq('school_id', admin.school_id));
    return { promoted: ids.length, class: next };
  }],

  // Which teacher teaches which learning area in which class
  ['GET', '/api/assignments', async ({ req }) => {
    const admin = await requireAdmin(req);
    return must(await db().from('teacher_assignments')
      .select('*, classes(id, grade, stream, year), learning_areas(id, name, code), staff(id, full_name, active)')
      .eq('school_id', admin.school_id).order('created_at'));
  }],

  // Assigning a learning area that already has a teacher in that class reassigns it.
  ['POST', '/api/assignments', async ({ req }) => {
    const admin = await requireAdmin(req);
    const body = await readJson(req);
    required(body, ['teacher_id', 'class_id', 'learning_area_id']);
    const checks = await Promise.all([
      db().from('staff').select('id, active').eq('id', body.teacher_id).eq('school_id', admin.school_id).maybeSingle(),
      db().from('classes').select('id, grade').eq('id', body.class_id).eq('school_id', admin.school_id).maybeSingle(),
      db().from('learning_areas').select('id, name, grades').eq('id', body.learning_area_id).maybeSingle(),
    ]);
    const [teacher, cls, area] = checks.map((c, i) => one(c, ['Teacher', 'Class', 'Learning area'][i]));
    if (teacher.active === false) throw new HttpError(400, 'That teacher has been removed');
    if (!(area.grades || []).includes(cls.grade)) throw new HttpError(400, `${area.name} is not taught in this grade`);
    return must(await db().from('teacher_assignments').upsert({
      school_id: admin.school_id, teacher_id: body.teacher_id, class_id: body.class_id, learning_area_id: body.learning_area_id,
    }, { onConflict: 'class_id,learning_area_id' }).select().single());
  }],

  ['DELETE', '/api/assignments/:id', async ({ req, params }) => {
    const admin = await requireAdmin(req);
    must(await db().from('teacher_assignments').delete().eq('id', params.id).eq('school_id', admin.school_id));
  }],
];

module.exports = { routes, publicSchool, validateGrading, validateLogo };
