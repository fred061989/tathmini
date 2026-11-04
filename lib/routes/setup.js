// School setup: school details, classes, staff (admins and teachers), learners, teacher assignments.

const { db, must, one } = require('../db');
const { HttpError, readJson, required } = require('../http');
const { authUser, findStaff, isOwner, requireAdmin } = require('../auth');
const { normalizeKenyanPhone } = require('../phone');
const { SCALES } = require('../cbc');
const { learnerFeeCents, kes, charge, credit } = require('../billing');

// Never send the school's Google token to the browser.
function publicSchool(s) {
  if (!s) return null;
  const { google_refresh_token, ...rest } = s;
  return { ...rest, google_connected: Boolean(google_refresh_token) };
}

const pick = (obj, keys) => Object.fromEntries(keys.filter(k => obj[k] !== undefined).map(k => [k, obj[k]]));

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

const SCHOOL_FIELDS = ['name', 'short_name', 'county', 'address', 'phone', 'email', 'motto', 'head_teacher_name', 'grading'];

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
    return { school: publicSchool(must(await db().from('schools').update(body).eq('id', admin.school_id).select().single())) };
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
    return must(await db().from('classes').insert({
      school_id: admin.school_id, grade: Number(body.grade), stream: body.stream || null,
      year: Number(body.year), class_teacher_id: body.class_teacher_id || null,
    }).select().single());
  }],

  ['PATCH', '/api/classes/:id', async ({ req, params }) => {
    const admin = await requireAdmin(req);
    const body = pick(await readJson(req), ['stream', 'class_teacher_id']);
    if (body.class_teacher_id === '') body.class_teacher_id = null;
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
    const email = body.email.trim().toLowerCase();
    const staff = must(await db().from('staff').insert({
      school_id: admin.school_id, full_name: body.full_name.trim(), email,
      phone: body.phone || null, role: body.role === 'admin' ? 'admin' : 'teacher',
    }).select().single());
    if (staff.role !== 'admin') return { staff, invited: false };
    const { error } = await db().auth.admin.inviteUserByEmail(email, { redirectTo: `${process.env.APP_URL}/app.html` });
    return { staff, invited: !error };
  }],

  ['PATCH', '/api/staff/:id', async ({ req, params }) => {
    const admin = await requireAdmin(req);
    const body = pick(await readJson(req), ['full_name', 'phone', 'role', 'active']);
    if (params.id === admin.id && (body.active === false || body.role === 'teacher')) throw new HttpError(400, 'You cannot remove your own admin access');
    return one(await db().from('staff').update(body).eq('id', params.id).eq('school_id', admin.school_id)
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
  // Existing ADM numbers are updated (e.g. moved to a new class) at no charge; each new learner
  // costs the yearly learner fee for the class's year, taken from the balance first.
  ['POST', '/api/learners', async ({ req }) => {
    const admin = await requireAdmin(req);
    const body = await readJson(req);
    required(body, ['class_id', 'learners']);
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
    const newCount = withoutAdm.length + new Set(withAdm.filter(r => !existingAdm.has(r.adm_no)).map(r => r.adm_no)).size;
    const fee = learnerFeeCents();
    const cost = newCount * fee;
    if (cost) {
      await charge(admin.school_id, cost, 'learner_fee', `${cls.year} fee for ${newCount} new learner${newCount === 1 ? '' : 's'}`,
        admin.email, `Adding ${newCount} new learner${newCount === 1 ? '' : 's'} (${kes(fee)} each for ${cls.year})`);
    }
    const saved = [];
    try {
      if (withAdm.length) saved.push(...must(await db().from('learners').upsert(withAdm, { onConflict: 'school_id,adm_no' }).select()));
      if (withoutAdm.length) saved.push(...must(await db().from('learners').insert(withoutAdm).select()));
    } catch (err) {
      if (cost) await credit(admin.school_id, cost, 'refund', 'Refund: learners could not be saved', admin.email);
      throw err;
    }
    const added = saved.filter(l => !l.adm_no || !existingAdm.has(l.adm_no));
    if (added.length) {
      must(await db().from('learner_years').insert(added.map(l => ({ learner_id: l.id, school_id: admin.school_id, year: cls.year, fee_cents: fee }))));
    }
    return { saved: saved.length, added: added.length, charged_cents: cost, learners: saved };
  }],

  ['PATCH', '/api/learners/:id', async ({ req, params }) => {
    const admin = await requireAdmin(req);
    const body = pick(await readJson(req), ['class_id', 'adm_no', 'assessment_no', 'first_name', 'last_name', 'gender', 'parent_name', 'parent_phone', 'active']);
    if (body.parent_phone) {
      body.parent_phone = normalizeKenyanPhone(body.parent_phone);
      if (!body.parent_phone) throw new HttpError(400, 'Invalid Kenyan phone number');
    }
    return one(await db().from('learners').update(body).eq('id', params.id).eq('school_id', admin.school_id).select().maybeSingle(), 'Learner');
  }],

  // Which teacher teaches which learning area in which class
  ['GET', '/api/assignments', async ({ req }) => {
    const admin = await requireAdmin(req);
    return must(await db().from('teacher_assignments')
      .select('*, classes(id, grade, stream, year), learning_areas(id, name, code), staff(id, full_name)')
      .eq('school_id', admin.school_id).order('created_at'));
  }],

  // Assigning a learning area that already has a teacher in that class reassigns it.
  ['POST', '/api/assignments', async ({ req }) => {
    const admin = await requireAdmin(req);
    const body = await readJson(req);
    required(body, ['teacher_id', 'class_id', 'learning_area_id']);
    const checks = await Promise.all([
      db().from('staff').select('id').eq('id', body.teacher_id).eq('school_id', admin.school_id).maybeSingle(),
      db().from('classes').select('id, grade').eq('id', body.class_id).eq('school_id', admin.school_id).maybeSingle(),
      db().from('learning_areas').select('id, name, grades').eq('id', body.learning_area_id).maybeSingle(),
    ]);
    const [, cls, area] = checks.map((c, i) => one(c, ['Teacher', 'Class', 'Learning area'][i]));
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

module.exports = { routes, publicSchool, validateGrading };
