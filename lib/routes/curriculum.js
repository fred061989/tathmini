// National curriculum: learning areas per grade, strands and sub-strands.
// Shared by every school; only the platform owner can change it.

const { db, must, one } = require('../db');
const { HttpError, readJson } = require('../http');
const { requireOwner, requireAdminOrOwner } = require('../auth');
const { parseGrade, parseCurriculumCsv, groupCurriculum, toCsv } = require('../curriculum');
const { starterRows } = require('../../data/curriculum');

const SELECT = 'id, name, code, grades, strands(id, grade, name, sort_order, sub_strands(id, name, sort_order))';

async function loadCurriculum(grade) {
  const areas = must(await db().from('learning_areas').select(SELECT).order('name'));
  const byOrder = (a, b) => a.sort_order - b.sort_order;
  return areas
    .filter(a => grade == null || (a.grades || []).includes(grade))
    .map(a => ({
      ...a,
      grades: [...(a.grades || [])].sort((x, y) => x - y),
      strands: (a.strands || []).filter(s => grade == null || s.grade === grade)
        .sort((x, y) => x.grade - y.grade || byOrder(x, y))
        .map(s => ({ ...s, sub_strands: [...(s.sub_strands || [])].sort(byOrder) })),
    }));
}

// Adds or updates learning areas; for each area and grade with strands in the import,
// that grade's strands are replaced. Other grades are left untouched.
async function applyCurriculum(areas) {
  const existing = must(await db().from('learning_areas').select('id, name, code, grades'));
  const stats = { areas_added: 0, areas_updated: 0, strands: 0, sub_strands: 0 };
  for (const a of areas) {
    const found = existing.find(e => e.name.toLowerCase() === a.name.toLowerCase());
    let id;
    if (found) {
      const grades = [...new Set([...(found.grades || []), ...a.grades])].sort((x, y) => x - y);
      must(await db().from('learning_areas').update({ grades, code: a.code || found.code }).eq('id', found.id));
      id = found.id;
      stats.areas_updated++;
    } else {
      id = must(await db().from('learning_areas').insert({ name: a.name, code: a.code, grades: a.grades }).select('id').single()).id;
      stats.areas_added++;
    }
    for (const [gradeKey, strands] of Object.entries(a.strands)) {
      const grade = Number(gradeKey);
      must(await db().from('strands').delete().eq('learning_area_id', id).eq('grade', grade));
      const saved = must(await db().from('strands').insert(strands.map((s, i) => ({ learning_area_id: id, grade, name: s.name, sort_order: i }))).select('id, name'));
      stats.strands += saved.length;
      const subs = strands.flatMap(s => s.subs.map((name, i) => ({ strand_id: saved.find(x => x.name === s.name).id, name, sort_order: i })));
      if (subs.length) must(await db().from('sub_strands').insert(subs));
      stats.sub_strands += subs.length;
    }
  }
  return stats;
}

const routes = [
  // ?grade=7 limits to learning areas taught in that grade, with that grade's strands.
  ['GET', '/api/curriculum', async ({ req, query }) => {
    await requireAdminOrOwner(req);
    const grade = query.grade != null && query.grade !== '' ? parseGrade(query.grade) : null;
    if (query.grade && grade == null) throw new HttpError(400, 'Unknown grade');
    return loadCurriculum(grade);
  }],

  ['GET', '/api/curriculum/export', async ({ req }) => {
    await requireOwner(req);
    return { csv: toCsv(await loadCurriculum(null)) };
  }],

  // Body: { csv } (pasted rows), { rows }, or { starter: true }. { dry_run: true } only validates.
  ['POST', '/api/curriculum/import', async ({ req }) => {
    await requireOwner(req);
    const body = await readJson(req);
    const rows = body.starter ? starterRows() : Array.isArray(body.rows) ? body.rows : parseCurriculumCsv(body.csv);
    if (!rows.length) throw new HttpError(400, 'Nothing to import');
    const { areas, errors } = groupCurriculum(rows);
    if (errors.length) throw new HttpError(400, `${errors.length} row(s) need fixing`, errors.slice(0, 50));
    const summary = areas.map(a => ({ name: a.name, grades: a.grades, strands: Object.values(a.strands).reduce((n, l) => n + l.length, 0) }));
    if (body.dry_run) return { dry_run: true, rows: rows.length, summary };
    return { rows: rows.length, summary, ...(await applyCurriculum(areas)) };
  }],

  ['PATCH', '/api/curriculum/areas/:id', async ({ req, params }) => {
    await requireOwner(req);
    const body = await readJson(req);
    const patch = {};
    if (body.code !== undefined) patch.code = String(body.code || '').trim().toUpperCase().slice(0, 4) || null;
    if (body.grades !== undefined) {
      const grades = body.grades.map(parseGrade);
      if (grades.some(g => g == null)) throw new HttpError(400, 'Unknown grade');
      patch.grades = [...new Set(grades)].sort((x, y) => x - y);
    }
    return one(await db().from('learning_areas').update(patch).eq('id', params.id).select('id, name, code, grades').maybeSingle(), 'Learning area');
  }],
];

module.exports = { routes, loadCurriculum };
