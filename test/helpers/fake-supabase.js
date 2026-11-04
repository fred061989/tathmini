// In-memory stand-in for the parts of supabase-js the API uses, so route
// handlers can be exercised end to end without a database.

const crypto = require('crypto');

const SINGULAR = { classes: 'class', learning_areas: 'learning_area', learners: 'learner', assessments: 'assessment', strands: 'strand', sub_strands: 'sub_strand', schools: 'school' };
const ONE_TO_MANY = new Set(['classes.learners', 'learning_areas.strands', 'strands.sub_strands']);
const DEFAULT_FK = { staff: 'teacher_id' };
const KEYS = { scores: ['assessment_id', 'learner_id', 'component_id'], results: ['assessment_id', 'learner_id'], learner_terms: ['learner_id', 'year', 'term'], report_comments: ['learner_id', 'year', 'term'] };
const IDENTITY = new Set();
const CASCADE = { payments: [['learner_terms', 'payment_id']], assessments: [['results', 'assessment_id'], ['scores', 'assessment_id'], ['assessment_components', 'assessment_id']] };
const DEFAULTS = {
  schools: { grading: {}, colour: '#1f7a4d', assessment_style: 'exams', google_refresh_token: null },
  payments: { status: 'pending' },
  staff: { active: true, user_id: null },
  learners: { active: true },
  assessments: { status: 'draft', per_strand: false, due_on: null, sheet_learners: [], sheet_tab: null },
};
const UNIQUE = { payments: ['mpesa_code'], learner_terms: ['learner_id', 'year', 'term'], learners: ['school_id', 'adm_no'], teacher_assignments: ['class_id', 'learning_area_id'], terms: ['school_id', 'year', 'term'] };

function splitTop(s) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

class Query {
  constructor(store, table) {
    Object.assign(this, { store, table, filters: [], op: 'select', sel: '*', mode: 'many', orders: [] });
  }
  select(sel = '*') { this.sel = sel; return this; }
  insert(rows) { this.op = 'insert'; this.payload = rows; return this; }
  upsert(rows, opts) { this.op = 'upsert'; this.payload = rows; this.onConflict = opts?.onConflict; return this; }
  update(patch) { this.op = 'update'; this.payload = patch; return this; }
  delete() { this.op = 'delete'; return this; }
  eq(c, v) { this.filters.push([c, x => x === v]); return this; }
  neq(c, v) { this.filters.push([c, x => x !== v]); return this; }
  in(c, vs) { this.filters.push([c, x => vs.includes(x)]); return this; }
  is(c, v) { this.filters.push([c, x => (x ?? null) === v]); return this; }
  not(c, op, v) { this.filters.push([c, x => !(op === 'is' ? (x ?? null) === v : x === v)]); return this; }
  ilike(c, v) { this.filters.push([c, x => String(x).toLowerCase() === String(v).toLowerCase()]); return this; }
  lte(c, v) { this.filters.push([c, x => String(x) <= String(v)]); return this; }
  gte(c, v) { this.filters.push([c, x => String(x) >= String(v)]); return this; }
  order(c, o = {}) { this.orders.push([c, o.ascending !== false]); return this; }
  limit(n) { this.lim = n; return this; }
  single() { this.mode = 'single'; return this; }
  maybeSingle() { this.mode = 'maybe'; return this; }
  then(resolve, reject) { return Promise.resolve().then(() => this.run()).then(resolve, reject); }

  rows() { return (this.store[this.table] ||= []); }

  embed(table, row, sel) {
    const out = {};
    for (const item of splitTop(sel)) {
      const m = item.match(/^(\w+)(?:!(\w+))?\((.*)\)$/s);
      if (!m) {
        if (item === '*') Object.assign(out, row); else out[item] = row[item];
        continue;
      }
      const [, rel, hint, sub] = m;
      const children = this.store[rel] || [];
      if (ONE_TO_MANY.has(`${table}.${rel}`)) {
        const list = children.filter(c => c[`${SINGULAR[table] || table}_id`] === row.id);
        out[rel] = sub === 'count' ? [{ count: list.length }] : list.map(c => this.embed(rel, c, sub));
      } else {
        const fk = hint && hint.endsWith('_fkey') ? hint.slice(table.length + 1, -5) : DEFAULT_FK[rel] || `${SINGULAR[rel] || rel}_id`;
        const target = children.find(c => c.id === row[fk]);
        out[rel] = target ? this.embed(rel, target, sub) : null;
      }
      if (hint === 'inner') out[`__inner_${rel}`] = true;
    }
    return out;
  }

  matches(row) {
    return this.filters.every(([c, fn]) => {
      if (c.includes('.')) {
        const [rel, col] = c.split('.');
        return row[rel] != null && fn(row[rel][col]);
      }
      return fn(row[c]);
    });
  }

  finish(data) {
    if (this.mode === 'single') {
      return data.length === 1 ? { data: data[0], error: null } : { data: null, error: { message: `expected 1 row, got ${data.length}` } };
    }
    if (this.mode === 'maybe') return { data: data[0] ?? null, error: null };
    return { data, error: null };
  }

  run() {
    const rows = this.rows();
    if (this.op === 'insert' || this.op === 'upsert') {
      const list = Array.isArray(this.payload) ? this.payload : [this.payload];
      const saved = [];
      for (const r of list) {
        const keys = this.onConflict ? this.onConflict.split(',') : KEYS[this.table];
        const existing = keys ? rows.find(x => keys.every(k => x[k] === r[k])) : null;
        if (existing && this.op === 'upsert') { Object.assign(existing, r); saved.push(existing); continue; }
        const uniq = UNIQUE[this.table];
        if (uniq && rows.some(x => uniq.every(k => x[k] != null && x[k] === r[k]))) {
          return { data: null, error: { code: '23505', message: 'duplicate', details: uniq.join(',') } };
        }
        const row = { created_at: new Date().toISOString(), ...DEFAULTS[this.table], ...r };
        if (!KEYS[this.table]) row.id = IDENTITY.has(this.table) ? rows.length + 1 : crypto.randomUUID();
        rows.push(row);
        saved.push(row);
      }
      return this.finish(saved.map(r => this.embed(this.table, r, this.sel)));
    }
    if (this.op === 'update') {
      const hit = rows.filter(r => this.matches(r));
      hit.forEach(r => Object.assign(r, this.payload));
      return this.finish(hit.map(r => this.embed(this.table, r, this.sel)));
    }
    if (this.op === 'delete') {
      const gone = new Set(rows.filter(r => this.matches(r)).map(r => r.id));
      this.store[this.table] = rows.filter(r => !this.matches(r));
      // ON DELETE CASCADE, as in db/schema.sql
      for (const [child, fk] of CASCADE[this.table] || []) {
        if (this.store[child]) this.store[child] = this.store[child].filter(r => !gone.has(r[fk]));
      }
      return { data: null, error: null };
    }
    // Filter and sort on full rows plus embedded relations (as Postgres does), then project.
    let pairs = rows.map(r => ({ full: { ...r, ...this.embed(this.table, r, this.sel) }, out: this.embed(this.table, r, this.sel) }))
      .filter(x => this.matches(x.full))
      .filter(x => Object.keys(x.out).filter(k => k.startsWith('__inner_')).every(k => x.out[k.slice(8)] != null));
    for (const [c, asc] of [...this.orders].reverse()) {
      pairs.sort(({ full: a }, { full: b }) => (a[c] == null) - (b[c] == null) || (a[c] < b[c] ? -1 : a[c] > b[c] ? 1 : 0) * (asc ? 1 : -1));
    }
    let data = pairs.map(x => x.out);
    data.forEach(r => Object.keys(r).filter(k => k.startsWith('__inner_')).forEach(k => delete r[k]));
    if (this.lim) data = data.slice(0, this.lim);
    return this.finish(data);
  }
}

function createFake() {
  const store = {};
  const users = new Map(); // token -> user
  return {
    store,
    users,
    from: table => new Query(store, table),
    rpc: async name => ({ data: null, error: { message: `unknown function ${name}` } }),
    auth: {
      getUser: async token => (users.has(token) ? { data: { user: users.get(token) }, error: null } : { data: null, error: { message: 'bad token' } }),
      admin: { inviteUserByEmail: async () => ({ data: {}, error: null }) },
    },
  };
}

module.exports = { createFake };
