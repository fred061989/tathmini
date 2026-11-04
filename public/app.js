// Tathmini CBC web app: one page, hash routes, plain DOM.

const S = { sb: null, staff: null, school: null, isOwner: false };
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const view = () => $('#view');

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const gradeLabel = g => (g === -1 ? 'PP1' : g === 0 ? 'PP2' : `Grade ${g}`);
const classLabel = c => (c ? `${gradeLabel(c.grade)}${c.stream ? ' ' + c.stream : ''} (${c.year})` : '');
const pill = lvl => (lvl ? `<span class="pill lvl-${esc(lvl)}">${esc(lvl)}</span>` : '<span class="muted">–</span>');
const pct = v => (v == null ? '–' : `${Number(v).toFixed(1).replace(/\.0$/, '')}%`);
const money = cents => `KES ${(cents / 100).toLocaleString('en-KE', { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
const STATUS = { draft: 'Draft', sheet_ready: 'With teacher', analysed: 'Analysed' };
const status = s => `<span class="pill status-${esc(s)}">${esc(STATUS[s] || s)}</span>`;
const KINDS = { opener: 'Opener', weekly: 'Weekly', monthly: 'Monthly', mid_term: 'Mid-term', end_term: 'End-term', custom: 'Custom' };
const LEVEL_COLORS = { E: 'var(--lvl-ee)', M: 'var(--lvl-me)', A: 'var(--lvl-ae)', B: 'var(--lvl-be)' };
const GRADES = [-1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
const thisYear = new Date().getFullYear();
// Kenyan school terms: roughly Jan–Apr, May–Aug, Sep–Nov.
const thisTerm = (m => (m <= 3 ? 1 : m <= 7 ? 2 : 3))(new Date().getMonth());
const hashParams = () => new URLSearchParams(location.hash.split('?')[1] || '');

async function api(method, path, body) {
  const { data } = await S.sb.auth.getSession();
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data.session?.access_token || ''}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(out.error || `Request failed (${res.status})`);
    err.details = out.details;
    throw err;
  }
  return out;
}

function notice(el, err, ok) {
  if (!el) return;
  if (!err) { el.className = 'notice'; el.innerHTML = esc(ok); return; }
  const details = Array.isArray(err.details) ? `<ul>${err.details.map(d => `<li>${esc(d)}</li>`).join('')}</ul>` : '';
  el.className = 'notice error';
  el.innerHTML = esc(err.message) + details;
}

// Wraps a form submit / button click with disable + error display.
function action(btn, msgEl, fn) {
  return async e => {
    e?.preventDefault();
    btn.disabled = true;
    try { await fn(); } catch (err) { notice(msgEl, err); } finally { btn.disabled = false; }
  };
}

function distBar(dist) {
  const total = Object.values(dist || {}).reduce((a, b) => a + b, 0);
  if (!total) return '<span class="muted">–</span>';
  return `<div class="bar" title="${esc(Object.entries(dist).map(([k, v]) => `${k}: ${v}`).join(', '))}">${
    Object.entries(dist).filter(([, v]) => v).map(([k, v]) =>
      `<span style="width:${(v / total) * 100}%;background:${LEVEL_COLORS[k[0]]};opacity:${k.endsWith('2') ? 0.65 : 1}"></span>`).join('')}</div>`;
}

// Class / term / year picker shared by the results and report form pages.
function periodPicker(classes, sel) {
  return `
    <label>Class <select name="class_id"><option value="">Choose…</option>${classes.map(c => `<option value="${c.id}" ${c.id === sel.class ? 'selected' : ''}>${esc(classLabel(c))}</option>`).join('')}</select></label>
    <label>Term <select name="term">${[1, 2, 3].map(t => `<option value="${t}" ${Number(sel.term) === t ? 'selected' : ''}>Term ${t}</option>`).join('')}</select></label>
    <label>Year <input name="year" type="number" value="${esc(sel.year)}" style="width:90px"></label>`;
}

function readPeriod(defaults = {}) {
  const q = hashParams();
  return { class: q.get('class') || defaults.class || '', term: Number(q.get('term') || thisTerm), year: Number(q.get('year') || thisYear) };
}

// ---------- Boot and navigation ----------

async function boot() {
  const cfg = await fetch('/api/config').then(r => r.json());
  S.sb = supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
  const { data } = await S.sb.auth.getSession();
  if (!data.session) return location.replace('/');
  $('#signout').onclick = async () => { await S.sb.auth.signOut(); location.replace('/'); };
  await loadMe();
  window.addEventListener('hashchange', route);
  route();
}

async function loadMe() {
  const me = await api('GET', '/api/me');
  S.staff = me.staff;
  S.school = me.school;
  S.isOwner = me.is_owner;
  $('#who').textContent = me.staff ? `${me.staff.full_name}${me.is_owner ? ' · owner' : ''}` : `${me.user.email}${me.is_owner ? ' · owner' : ''}`;
  $('#school-name').textContent = me.school?.name || '';
}

const TABS = [['dashboard', 'Assessments'], ['new', 'New assessment'], ['results', 'Class results'], ['reports', 'Report forms'],
  ['classes', 'Classes & learners'], ['teachers', 'Teachers'], ['curriculum', 'Curriculum'], ['settings', 'Settings']];
const OWNER_TABS = [['curriculum', 'National curriculum'], ['schools', 'All schools']];

function route() {
  if (!S.staff && !S.isOwner) return renderOnboarding();
  const tabs = S.staff ? (S.isOwner ? [...TABS, ['schools', 'All schools']] : TABS) : OWNER_TABS;
  const [name, arg] = location.hash.replace(/^#/, '').split(/[/?]/);
  const current = tabs.some(t => t[0] === name) || (S.staff && name) ? name : tabs[0][0];
  const activeTab = { assessment: 'dashboard', class: 'classes', report: 'reports' }[current] || current;
  $('#tabs').innerHTML = tabs.map(([id, label]) => `<a href="#${id}" class="${id === activeTab ? 'active' : ''}">${label}</a>`).join('');
  const views = {
    dashboard: renderDashboard, new: renderNewAssessment, assessment: renderAssessment, results: renderResults,
    reports: renderReports, report: renderReportForms, classes: renderClasses, class: renderClass,
    teachers: renderTeachers, curriculum: renderCurriculum, settings: renderSettings, schools: renderSchools,
  };
  const fn = views[current] || views[tabs[0][0]];
  view().innerHTML = '<p class="muted">Loading…</p>';
  fn(arg).catch(err => { view().innerHTML = '<div id="m"></div>'; notice($('#m'), err); });
}

// ---------- Onboarding ----------

async function renderOnboarding() {
  $('#tabs').innerHTML = '';
  view().innerHTML = `
    <div class="center card">
      <h1>Register your school</h1>
      <p class="muted">For head teachers and school admins. Teachers don't need accounts: they receive their score sheets by Gmail.
        If your school is already registered, ask its admin to add you as an admin.</p>
      <form id="f">
        <p><label>School name <input name="name" required></label></p>
        <p><label>Short name (e.g. Kilimani JS) <input name="short_name" maxlength="30"></label></p>
        <p><label>County <input name="county"></label></p>
        <p><label>Your full name <input name="full_name" required></label></p>
        <p><label>Your phone <input name="phone" placeholder="07…"></label></p>
        <button>Register school</button>
      </form>
      <div id="m"></div>
    </div>`;
  const f = $('#f');
  f.onsubmit = action($('button', f), $('#m'), async () => {
    await api('POST', '/api/schools', Object.fromEntries(new FormData(f)));
    await loadMe();
    location.hash = '#settings';
    route();
  });
}

// ---------- Assessments dashboard ----------

async function renderDashboard() {
  const [list, billing] = await Promise.all([api('GET', '/api/assessments'), api('GET', '/api/billing')]);
  const count = s => list.filter(a => a.status === s).length;
  view().innerHTML = `
    <div class="row" style="justify-content:space-between"><h1>Assessments</h1><a class="btn" href="#new">New assessment</a></div>
    ${S.school.google_connected ? '' : '<div class="notice error">Google is not connected, so score sheets cannot be sent to teachers. <a href="#settings">Connect it in Settings</a>.</div>'}
    ${billing.unpaid.length ? `<div class="notice error">${billing.unpaid.length} learner(s) are not paid for Term ${billing.term} ${billing.year}, so they are left out of new sheets and report forms. <a href="#settings">Pay in Settings → Billing</a>.</div>` : ''}
    <div class="grid">
      <div class="stat"><div class="v">${count('draft')}</div><div class="k">Drafts (no sheet yet)</div></div>
      <div class="stat"><div class="v">${count('sheet_ready')}</div><div class="k">With teachers</div></div>
      <div class="stat"><div class="v">${count('analysed')}</div><div class="k">Analysed</div></div>
      <div class="stat"><div class="v">${money(billing.balance_cents)}</div><div class="k">Account balance</div></div>
    </div>
    <div id="m" style="margin-top:12px"></div>
    <div class="table-wrap"><table>
      <thead><tr><th>Assessment</th><th>Teacher</th><th>Date</th><th>Status</th><th>Sheet</th><th class="num">Mean</th><th></th></tr></thead>
      <tbody>${list.map(a => `
        <tr>
          <td><a href="#assessment/${a.id}">${esc(a.title)}</a><div class="muted">${esc(a.learning_areas?.name)} · ${esc(classLabel(a.classes))}</div></td>
          <td>${esc(a.staff?.full_name || '')}</td>
          <td>${esc(a.assessed_on)}</td>
          <td>${status(a.status)}</td>
          <td>${a.sheet_url ? `<a href="${esc(a.sheet_url)}" target="_blank" rel="noopener">Open</a>` : ''}
            ${a.status === 'sheet_ready' ? `<div><a href="#" data-progress="${a.id}">Check progress</a></div>` : ''}</td>
          <td class="num">${a.summary ? `${pct(a.summary.mean_percent)} ${pill(a.summary.mean_level)}` : ''}</td>
          <td>${a.sheet_id ? `<button data-analyse="${a.id}" class="${a.status === 'sheet_ready' ? '' : 'secondary'}">${a.status === 'analysed' ? 'Re-analyse' : 'Analyse'}</button>` : ''}</td>
        </tr>`).join('') || '<tr><td colspan="7" class="muted">No assessments yet. Press “New assessment” to create one and send its sheet to the teacher.</td></tr>'}
      </tbody></table></div>`;
  $$('[data-analyse]').forEach(b => {
    b.onclick = action(b, $('#m'), async () => {
      await api('POST', `/api/assessments/${b.dataset.analyse}/analyse`, {});
      location.hash = `#assessment/${b.dataset.analyse}`;
    });
  });
  $$('[data-progress]').forEach(link => {
    link.onclick = async e => {
      e.preventDefault();
      link.textContent = 'Checking…';
      try {
        const p = await api('GET', `/api/assessments/${link.dataset.progress}/progress`);
        link.textContent = p.complete ? `All ${p.total} entered ✓` : `${p.entered}/${p.total} entered${p.partial ? `, ${p.partial} partly` : ''}`;
      } catch (err) { link.textContent = 'Check progress'; notice($('#m'), err); }
    };
  });
}

// ---------- New assessment ----------

async function renderNewAssessment() {
  const [classes, assignments, areas] = await Promise.all([api('GET', '/api/classes'), api('GET', '/api/assignments'), api('GET', '/api/curriculum')]);
  view().innerHTML = `
    <h1>New assessment</h1>
    <p class="muted">Choose the class and learning areas. A Google Sheet with the class list is created for each learning area and
      shared with its teacher by Gmail. Teachers only fill in scores (and a short comment per learner if they like).</p>
    ${S.school.google_connected ? '' : '<div class="notice error">Google is not connected, so assessments will be saved as drafts. <a href="#settings">Connect it in Settings</a>.</div>'}
    <form id="na" class="card">
      <p><label>Class <select name="class_id" required><option value="">Choose…</option>${classes.map(c => `<option value="${c.id}">${esc(classLabel(c))}</option>`).join('')}</select></label></p>
      <div id="areas"></div>
      <div class="inline">
        <label>Type <select name="kind">${Object.entries(KINDS).map(([k, v]) => `<option value="${k}" ${k === 'monthly' ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
        <label>Term <select name="term">${[1, 2, 3].map(t => `<option ${t === thisTerm ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
        <label>Week (optional) <input name="week" type="number" min="1" max="14" style="width:90px"></label>
        <label>Year <input name="year" type="number" value="${thisYear}" style="width:90px"></label>
        <label>Date <input name="assessed_on" type="date" value="${new Date().toISOString().slice(0, 10)}"></label>
      </div>
      <p><label>Title (optional, one learning area only) <input name="title" placeholder="Created automatically if left blank"></label></p>
      <p><label>Score by <select name="mode">
        <option value="total">Total marks</option>
        <option value="strand">Each strand (one learning area at a time)</option>
        <option value="sub">Each sub-strand (one learning area at a time)</option>
      </select></label></p>
      <div id="total"><label>Out of (maximum marks) <input name="max_score" type="number" min="1" value="100" style="width:120px"></label></div>
      <div id="strands" hidden>
        <p class="muted">From the national curriculum for this grade. Remove what is not being assessed and set the maximum marks for each:</p>
        <div id="rows"></div>
        <button type="button" class="secondary" id="add-strand">Add strand</button>
      </div>
      <p><button id="create">Create and send sheet</button></p>
      <div id="fm"></div>
    </form>`;
  const f = $('#na');
  const chosen = () => $$('[name=asg]:checked', f).map(i => assignments.find(x => x.id === i.value));
  const detailed = () => f.mode.value !== 'total';

  function fillStrands() {
    const sel = chosen();
    if (!detailed() || sel.length !== 1) { $('#rows').innerHTML = ''; return; }
    const asg = sel[0];
    const area = areas.find(a => a.id === asg.learning_area_id);
    const strands = (area?.strands || []).filter(st => st.grade === asg.classes.grade);
    const rows = f.mode.value === 'sub'
      ? strands.flatMap(st => (st.sub_strands.length ? st.sub_strands.map(ss => strandRow(ss.name, st.id, ss.id)) : [strandRow(st.name, st.id)]))
      : strands.map(st => strandRow(st.name, st.id));
    $('#rows').innerHTML = rows.join('') || strandRow('');
    if (!strands.length) notice($('#fm'), null, 'No strands are loaded for this learning area and grade yet; type them in below.');
  }
  function sync() {
    const n = chosen().length;
    $('#strands').hidden = !detailed();
    $('#total').hidden = detailed();
    $('#create').textContent = n > 1 ? `Create and send ${n} sheets` : 'Create and send sheet';
    if (detailed() && n > 1) notice($('#fm'), new Error('Strand and sub-strand scoring works one learning area at a time. Tick a single learning area.'));
  }
  f.class_id.onchange = () => {
    const list = assignments.filter(x => x.class_id === f.class_id.value).sort((a, b) => a.learning_areas.name.localeCompare(b.learning_areas.name));
    $('#areas').innerHTML = list.length
      ? `<p class="muted">Learning areas (teacher):</p>${list.map(x => `<p><label class="check">
          <input type="checkbox" name="asg" value="${x.id}"> ${esc(x.learning_areas.name)} <span class="muted">(${esc(x.staff.full_name)})</span></label></p>`).join('')}`
      : '<p class="notice error">No learning areas are assigned to teachers for this class yet. <a href="#teachers">Assign them under Teachers</a>.</p>';
    fillStrands(); sync();
  };
  f.addEventListener('change', e => { if (['asg', 'mode'].includes(e.target.name)) { $('#fm').innerHTML = ''; fillStrands(); sync(); } });
  $('#add-strand').onclick = () => $('#rows').insertAdjacentHTML('beforeend', strandRow(''));
  f.addEventListener('click', e => { if (e.target.matches('[data-remove]')) e.target.closest('.strand-row').remove(); });

  f.onsubmit = action($('#create'), $('#fm'), async () => {
    const fd = Object.fromEntries(new FormData(f));
    const sel = chosen();
    if (!sel.length) throw new Error('Tick at least one learning area');
    const components = detailed()
      ? $$('.strand-row', f).map(r => ({ label: $('[name=label]', r).value.trim(), max_score: Number($('[name=max]', r).value),
        strand_id: r.dataset.strand || null, sub_strand_id: r.dataset.sub || null })).filter(c => c.label)
      : [];
    if (detailed() && !components.length) throw new Error('Add at least one strand');
    const out = await api('POST', '/api/assessments', {
      assignment_ids: sel.map(x => x.id), kind: fd.kind, term: fd.term, week: fd.week || null, year: fd.year,
      assessed_on: fd.assessed_on, title: fd.title, per_strand: detailed(), components, max_score: Number(fd.max_score),
    });
    const notes = out.created.filter(c => c.note).map(c => `${c.assessment.title}: ${c.note}`);
    if (out.created.length === 1 && !notes.length) { location.hash = `#assessment/${out.created[0].assessment.id}`; return; }
    location.hash = '#dashboard';
    if (notes.length) setTimeout(() => notice($('#m'), { message: 'Some sheets were not created', details: notes }), 300);
  });
}

function strandRow(label, strandId, subId) {
  return `<div class="strand-row" ${strandId ? `data-strand="${esc(strandId)}"` : ''} ${subId ? `data-sub="${esc(subId)}"` : ''}>
    <input name="label" value="${esc(label)}" placeholder="Strand / sub-strand">
    <input name="max" type="number" min="1" placeholder="Out of" required>
    <button type="button" class="danger" data-remove>✕</button></div>`;
}

// ---------- One assessment ----------

async function renderAssessment(id) {
  const { assessment: a, components, results, learners, scores, term_closed: closed } = await api('GET', `/api/assessments/${id}`);
  const s = a.summary;
  view().innerHTML = `
    <p><a href="#dashboard">← Assessments</a></p>
    <h1>${esc(a.title)}</h1>
    <p class="muted">${esc(a.learning_areas?.name)} · ${esc(classLabel(a.classes))} · ${esc(KINDS[a.kind])} · Term ${a.term} · ${esc(a.assessed_on)} · ${esc(a.staff?.full_name || '')} · ${status(a.status)}</p>
    <div class="row">
      ${a.sheet_url ? `<a class="btn secondary" href="${esc(a.sheet_url)}" target="_blank" rel="noopener">Open Google Sheet</a>` : ''}
      ${!a.sheet_id ? '<button id="gen">Create and send sheet</button>' : ''}
      ${a.status === 'sheet_ready' ? '<button class="secondary" id="progress">Check progress</button>' : ''}
      ${a.sheet_id && !closed ? `<button id="analyse">${s ? 'Re-analyse from sheet' : 'Analyse'}</button>` : ''}
      ${closed ? '' : '<button class="secondary" id="type">Enter scores here</button>'}
      ${closed ? '' : '<span style="flex:1"></span><button class="danger" id="delete">Delete assessment</button>'}
      ${s ? `<a class="btn secondary" href="#results?class=${a.class_id}&term=${a.term}&year=${a.year}">Class results for the term</a>` : ''}
    </div>
    ${closed ? `<p class="notice">Term ${a.term} ${a.year} is closed, so these results are locked.</p>` : ''}
    <div id="m" style="margin-top:12px"></div>
    <div id="grid"></div>
    <p class="muted">Scored on: ${components.map(c => `${esc(c.label)} (/${Number(c.max_score)})`).join(', ')}</p>
    ${s ? summaryHtml(s) : ''}
    ${results.length ? resultsHtml(results, components) : ''}`;
  const m = $('#m');
  if ($('#gen')) $('#gen').onclick = action($('#gen'), m, async () => { await api('POST', `/api/assessments/${id}/sheet`); route(); });
  if ($('#progress')) {
    $('#progress').onclick = action($('#progress'), m, async () => {
      const p = await api('GET', `/api/assessments/${id}/progress`);
      notice(m, null, `${p.entered} of ${p.total} learners entered by ${a.staff?.full_name || 'the teacher'}${p.partial ? ` (${p.partial} more partly filled in)` : ''}${p.complete ? ' — ready to analyse.' : '.'}${p.issues.length ? ' ' + p.issues.join(' ') : ''}`);
    });
  }
  if ($('#type')) $('#type').onclick = () => scoreGrid($('#grid'), a, components, learners, scores);
  if ($('#delete')) {
    $('#delete').onclick = action($('#delete'), m, async () => {
      if (!confirm(`Delete "${a.title}"? Its scores and results are deleted too. The Google Sheet stays in the school's Google Drive.`)) return;
      await api('DELETE', `/api/assessments/${a.id}`);
      location.hash = '#dashboard';
    });
  }
  if ($('#analyse')) {
    $('#analyse').onclick = action($('#analyse'), m, async () => {
      const out = await api('POST', `/api/assessments/${id}/analyse`, {});
      await route();
      if (out.issues?.length) notice($('#m'), null, `Analysed. Notes: ${out.issues.join(' ')}`);
    });
  }
}

// Typing scores in the app: a backup when a teacher cannot use the Google Sheet.
function scoreGrid(box, a, components, learners, saved) {
  const key = (l, c) => `${l}:${c}`;
  const savedOf = new Map(saved.map(x => [key(x.learner_id, x.component_id), x]));
  const first = components[0];
  box.innerHTML = `
    <div class="card">
      <h2 style="margin-top:0">Enter scores</h2>
      <p class="muted">Type each learner's marks, tick Absent for learners who missed the assessment, and add a short comment if you like
        (it appears on the report form). ${a.sheet_id ? 'Saving here replaces what was read from the Google Sheet; analysing from the sheet again later would replace these.' : ''}</p>
      <form id="sg"><div class="table-wrap"><table>
        <thead><tr><th>Learner</th>${components.map(c => `<th class="num">${esc(c.label)} (/${Number(c.max_score)})</th>`).join('')}<th>Absent</th><th>Comment</th></tr></thead>
        <tbody>${learners.map(l => {
          const firstSaved = savedOf.get(key(l.id, first.id));
          return `<tr data-l="${l.id}"><td>${esc(l.first_name)} ${esc(l.last_name)} <span class="muted">${esc(l.adm_no || '')}</span></td>
            ${components.map(c => `<td class="num"><input type="number" min="0" max="${Number(c.max_score)}" step="any" data-c="${c.id}"
              value="${esc(savedOf.get(key(l.id, c.id))?.raw_score ?? '')}" style="width:80px"></td>`).join('')}
            <td><input type="checkbox" data-absent ${firstSaved?.absent ? 'checked' : ''}></td>
            <td><input data-comment value="${esc(firstSaved?.comment || '')}" maxlength="300" style="min-width:220px"></td></tr>`;
        }).join('') || `<tr><td colspan="${components.length + 3}" class="muted">No learners paid for this term in this class.</td></tr>`}</tbody>
      </table></div>
      <p class="row"><button>Save and analyse</button><button type="button" class="secondary" data-close>Close</button></p></form>
      <div data-msg></div>
    </div>`;
  const f = $('#sg', box);
  $('[data-close]', box).onclick = () => { box.innerHTML = ''; };
  f.onsubmit = action($('button', f), $('[data-msg]', box), async () => {
    const out = [];
    for (const row of $$('[data-l]', f)) {
      const absent = $('[data-absent]', row).checked;
      const comment = $('[data-comment]', row).value.trim() || null;
      $$('[data-c]', row).forEach((input, i) => out.push({
        learner_id: row.dataset.l, component_id: input.dataset.c, raw_score: absent ? null : input.value, absent, comment: i === 0 ? comment : null,
      }));
    }
    await api('POST', `/api/assessments/${a.id}/analyse`, { scores: out });
    route();
  });
}

function summaryHtml(s) {
  return `
    <h2>Class summary</h2>
    <div class="grid">
      <div class="stat"><div class="v">${pct(s.mean_percent)} ${pill(s.mean_level)}</div><div class="k">Class mean</div></div>
      <div class="stat"><div class="v">${s.meeting_or_above}/${s.assessed}</div><div class="k">Meeting expectations or above</div></div>
      <div class="stat"><div class="v">${s.absent}</div><div class="k">Absent</div></div>
      <div class="stat"><div class="v">${s.mean_change == null ? '–' : (s.mean_change > 0 ? '+' : '') + s.mean_change}</div><div class="k">Change vs last assessment (pts)</div></div>
    </div>
    <div class="card" style="margin-top:12px"><strong>Level distribution</strong>
      <div style="margin:8px 0">${distBar(s.distribution)}</div>
      <div class="muted">${Object.entries(s.distribution).map(([k, v]) => `${k}: ${v}`).join(' · ')}</div></div>
    ${s.components.length > 1 ? `
    <h2>Strands</h2>
    <div class="table-wrap"><table>
      <thead><tr><th>Strand</th><th class="num">Mean</th><th>Level</th><th>Distribution</th><th class="num">Need support</th></tr></thead>
      <tbody>${s.components.map(c => `<tr><td>${esc(c.label)}</td><td class="num">${pct(c.mean_percent)}</td><td>${pill(c.level)}</td><td>${distBar(c.distribution)}</td><td class="num">${c.needs_support}</td></tr>`).join('')}</tbody>
    </table></div>
    ${s.weak_components.length ? `<p class="notice error">Re-teach: ${s.weak_components.map(esc).join(', ')}</p>` : ''}` : ''}
    ${s.needs_support.length ? `<h2>Learners needing support (${s.needs_support.length})</h2><p>${s.needs_support.map(n => `${esc(n.name)} ${pill(n.level)}`).join(' · ')}</p>` : ''}
    ${s.most_improved.length ? `<h2>Most improved</h2><p>${s.most_improved.map(n => `${esc(n.name)} (+${n.change})`).join(' · ')}</p>` : ''}`;
}

function resultsHtml(results, components) {
  const multi = components.length > 1;
  return `
    <h2>Learners</h2>
    <div class="table-wrap"><table>
      <thead><tr><th>Learner</th><th class="num">Score</th><th>Level</th>${multi ? components.map(c => `<th>${esc(c.label)}</th>`).join('') : ''}<th class="num">Change</th></tr></thead>
      <tbody>${results.map(r => `<tr>
        <td>${esc(r.learners.first_name)} ${esc(r.learners.last_name)} <span class="muted">${esc(r.learners.adm_no || '')}</span></td>
        <td class="num">${r.status === 'assessed' ? pct(r.percent) : `<span class="muted">${r.status}</span>`}</td>
        <td>${pill(r.level)}</td>
        ${multi ? r.strands.map(st => `<td>${st.raw == null ? '<span class="muted">–</span>' : `${st.raw}/${st.max_score} ${pill(st.level)}`}</td>`).join('') : ''}
        <td class="num">${r.change == null ? '' : (r.change > 0 ? '+' : '') + r.change}</td>
      </tr>`).join('')}</tbody>
    </table></div>`;
}

// ---------- Class results: the class teacher's sheet for a term ----------

async function renderResults() {
  const classes = await api('GET', '/api/classes');
  const sel = readPeriod();
  view().innerHTML = `
    <h1 class="no-print">Class results</h1>
    <p class="muted no-print">The class teacher's sheet: every learner's term average per learning area, with class means.
      Each assessment type (monthly, end-term…) counts once in a term average; absences are left out, not counted as zero.</p>
    <form id="pf" class="card inline no-print">${periodPicker(classes, sel)}<button>Show</button></form>
    <div id="m"></div><div id="out"></div>`;
  const f = $('#pf');
  f.onsubmit = e => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(f));
    if (!fd.class_id) return notice($('#m'), new Error('Choose a class'));
    location.hash = `#results?class=${fd.class_id}&term=${fd.term}&year=${fd.year}`;
  };
  if (!sel.class) return;
  const s = await api('GET', `/api/classes/${sel.class}/term?year=${sel.year}&term=${sel.term}`);
  if (!s.assessments) { $('#out').innerHTML = `<p class="muted">No analysed assessments for ${esc(s.class.label)} in Term ${s.term} ${s.year} yet.</p>`; return; }
  $('#out').innerHTML = `
    <div class="row no-print" style="margin-bottom:12px">
      <button id="print">Print class sheet</button>
      <a class="btn secondary" href="#reports?class=${sel.class}&term=${sel.term}&year=${sel.year}">Report forms for this class</a>
    </div>
    <div class="sheet-print">
      <h2 style="margin-top:0">${esc(S.school.name)} · ${esc(s.class.label)} · Term ${s.term} ${s.year}</h2>
      <p class="muted">Class teacher: ${esc(s.class.class_teacher || '–')} · ${s.assessments} assessments · Class mean ${pct(s.class_mean_percent)} ${pill(s.class_level)} ·
        ${s.meeting_or_above} of ${s.learners.filter(l => l.overall_percent != null).length} learners meeting expectations or above</p>
      <div class="table-wrap"><table>
        <thead><tr><th>Learner</th><th>ADM</th>${s.areas.map(a => `<th class="num" title="${esc(a.name)}">${esc(a.code || a.name)}</th>`).join('')}<th class="num">Overall</th></tr></thead>
        <tbody>
          ${s.learners.map(l => `<tr><td>${esc(l.name)}</td><td>${esc(l.adm_no || '')}</td>
            ${s.areas.map(a => { const x = l.areas[a.id]; return `<td class="num">${x.average == null ? '<span class="muted">–</span>' : `${pct(x.average)} ${pill(x.level)}`}</td>`; }).join('')}
            <td class="num"><strong>${pct(l.overall_percent)}</strong> ${pill(l.overall_level)}</td></tr>`).join('')}
          <tr><td colspan="2"><strong>Class mean</strong></td>${s.areas.map(a => `<td class="num"><strong>${pct(a.mean_percent)}</strong> ${pill(a.level)}</td>`).join('')}
            <td class="num"><strong>${pct(s.class_mean_percent)}</strong> ${pill(s.class_level)}</td></tr>
        </tbody></table></div>
      <p class="muted">${s.areas.map(a => `${esc(a.code || '')} = ${esc(a.name)}`).join(' · ')}</p>
    </div>`;
  // The class sheet prints landscape with margins; report forms print portrait edge to edge.
  $('#print').onclick = () => {
    const style = document.createElement('style');
    style.textContent = '@page { size: A4 landscape; margin: 10mm; }';
    document.head.appendChild(style);
    window.print();
    style.remove();
  };
}

// ---------- Report forms: comments, term dates, closing the term ----------

async function renderReports() {
  const classes = await api('GET', '/api/classes');
  const sel = readPeriod();
  view().innerHTML = `
    <h1>Report forms</h1>
    <p class="muted">Termly report forms, one A4 page per learner. The class and head teacher's comments are drafted from each learner's
      results; edit them here before printing. Close the term when the reports are final.</p>
    <form id="pf" class="card inline">${periodPicker(classes, sel)}<button>Show</button></form>
    <div id="m"></div><div id="out"></div>`;
  const f = $('#pf');
  f.onsubmit = e => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(f));
    if (!fd.class_id) return notice($('#m'), new Error('Choose a class'));
    location.hash = `#reports?class=${fd.class_id}&term=${fd.term}&year=${fd.year}`;
  };
  if (!sel.class) return;
  const r = await api('GET', `/api/reports/termly?class_id=${sel.class}&year=${sel.year}&term=${sel.term}`);
  const t = r.term_record;
  const closed = Boolean(t.closed_at);
  const q = `class=${sel.class}&term=${sel.term}&year=${sel.year}`;
  $('#out').innerHTML = `
    <div class="card">
      <div class="row" style="justify-content:space-between">
        <strong>${esc(r.class.label)} · Term ${r.term} ${r.year}</strong>
        <span class="pill" style="color:${closed ? 'var(--accent)' : 'var(--warn)'}">${closed ? 'Term closed: reports are final' : 'Term open: reports are provisional'}</span>
      </div>
      <form id="tf" class="inline" style="margin-top:12px">
        <label>Closing date <input type="date" name="closing_date" value="${esc(t.closing_date || '')}" ${closed ? 'disabled' : ''}></label>
        <label>Next term begins <input type="date" name="next_term_date" value="${esc(t.next_term_date || '')}" ${closed ? 'disabled' : ''}></label>
        ${closed ? '' : '<button class="secondary">Save dates</button>'}
      </form>
      <div class="row" style="margin-top:12px">
        ${r.reports.length ? `<a class="btn" href="#report?${q}">Print all ${r.reports.length} report forms</a>` : ''}
        ${closed ? '<button class="secondary" id="reopen">Reopen term</button>' : '<button class="secondary" id="close">Close term</button>'}
      </div>
      <div id="tm" style="margin-top:8px"></div>
    </div>
    ${r.reports.length ? '' : '<p class="muted">No analysed results for this class and term yet.</p>'}
    ${r.reports.map(x => `
      <div class="card" data-learner="${x.learner_id}">
        <div class="row" style="justify-content:space-between">
          <div><strong>${esc(x.name)}</strong> <span class="muted">ADM ${esc(x.adm_no || '–')}</span> · ${pct(x.overall_percent)} ${pill(x.overall_level)}
            ${x.comments_saved ? '' : '<span class="muted"> · comments drafted, not yet saved</span>'}</div>
          <a class="btn secondary" href="#report?${q}&learner=${x.learner_id}">Print report</a>
        </div>
        <div class="comments-grid" style="margin-top:10px">
          <label>Class teacher's comment <textarea name="class_comment" ${closed ? 'disabled' : ''}>${esc(x.class_comment)}</textarea></label>
          <label>Head teacher's comment <textarea name="head_comment" ${closed ? 'disabled' : ''}>${esc(x.head_comment)}</textarea></label>
          <label>Co-curricular (optional) <textarea name="co_curricular" placeholder="e.g. Athletics (county), Music club" ${closed ? 'disabled' : ''}>${esc(x.co_curricular)}</textarea></label>
        </div>
        ${closed ? '' : '<div class="row" style="margin-top:8px"><button class="secondary" data-save>Save comments</button><span class="muted" data-msg></span></div>'}
      </div>`).join('')}`;

  const tm = $('#tm');
  const tf = $('#tf');
  if (!closed) {
    tf.onsubmit = action($('button', tf), tm, async () => {
      await api('PUT', '/api/terms', { year: sel.year, term: sel.term, ...Object.fromEntries(new FormData(tf)) });
      notice(tm, null, 'Dates saved.');
    });
  }
  if ($('#close')) {
    $('#close').onclick = action($('#close'), tm, async () => {
      if (!confirm(`Close Term ${sel.term} ${sel.year}? Results and comments for this term will be locked so printed reports stay final.`)) return;
      await api('POST', '/api/terms/close', { year: sel.year, term: sel.term });
      route();
    });
  }
  if ($('#reopen')) $('#reopen').onclick = action($('#reopen'), tm, async () => { await api('POST', '/api/terms/reopen', { year: sel.year, term: sel.term }); route(); });
  $$('[data-learner]').forEach(card => {
    const btn = $('[data-save]', card);
    if (!btn) return;
    btn.onclick = async () => {
      btn.disabled = true;
      const msg = $('[data-msg]', card);
      try {
        await api('PUT', '/api/report-comments', {
          learner_id: card.dataset.learner, year: sel.year, term: sel.term,
          class_comment: $('[name=class_comment]', card).value, head_comment: $('[name=head_comment]', card).value,
          co_curricular: $('[name=co_curricular]', card).value,
        });
        msg.textContent = 'Saved.';
      } catch (err) { msg.textContent = err.message; } finally { btn.disabled = false; }
    };
  });
}

// CBC levels for the key on the report (defaults plus the school's overrides).
function levelsFor(grade) {
  const id = grade >= 7 ? 'cbc8' : 'cbc4';
  const base = id === 'cbc8'
    ? [['EE1', 90], ['EE2', 75], ['ME1', 58], ['ME2', 41], ['AE1', 31], ['AE2', 21], ['BE1', 11], ['BE2', 0]]
    : [['EE', 80], ['ME', 50], ['AE', 30], ['BE', 0]];
  const o = S.school.grading?.[id] || {};
  const levels = base.map(([code, min]) => [code, o[code] != null ? Number(o[code]) : min]);
  levels[levels.length - 1][1] = 0;
  return { id, levels: levels.map(([code, min], i) => ({ code, range: i ? `${min}–${levels[i - 1][1] - 1}%` : `${min}–100%` })) };
}

const LEVEL_NAMES = { EE: 'Exceeding Expectations', ME: 'Meeting Expectations', AE: 'Approaching Expectations', BE: 'Below Expectations' };
const rfPill = code => (code ? `<span class="pill l-${esc(code.slice(0, 2))}">${esc(code)}</span>` : '–');
const longDate = d => (d ? new Date(d + 'T00:00:00').toLocaleDateString('en-KE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) : '____________________');

function reportForm(x, r) {
  const sch = r.school;
  const crest = sch.name.split(/\s+/).filter(w => /^[A-Za-z]/.test(w) && !/^(of|and|the)$/i.test(w)).map(w => w[0]).join('').slice(0, 3).toUpperCase();
  const meta = [sch.address, sch.county ? `${sch.county} County` : '', sch.phone, sch.email].filter(Boolean).map(esc).join(' &nbsp;·&nbsp; ');
  const key = levelsFor(r.class.grade);
  const pairs = [];
  for (let i = 0; i < key.levels.length; i += 2) pairs.push(key.levels.slice(i, i + 2));
  const extra = [];
  if (x.co_curricular) extra.push(`<div><b>Co-curricular:</b> ${esc(x.co_curricular)}</div>`);
  return `
  <section class="rf">
    <div class="head">
      ${sch.logo ? `<img class="logo" src="${esc(sch.logo)}" alt="">` : `<div class="crest">${esc(crest)}</div>`}
      <div class="school"><div class="name">${esc(sch.name)}</div>${meta ? `<div class="meta">${meta}</div>` : ''}${sch.motto ? `<div class="motto">“${esc(sch.motto)}”</div>` : ''}</div>
      <div></div>
    </div>
    <div class="band">LEARNER'S TERMLY REPORT &nbsp;<span>· TERM ${r.term}, ${r.year}</span></div>
    ${r.term_record.closed_at ? '' : '<div class="provisional">PROVISIONAL · TERM NOT YET CLOSED</div>'}
    <div class="facts">
      <div><span>Learner's name</span><b>${esc(x.name.toUpperCase())}</b></div>
      <div><span>ADM no.</span><b>${esc(x.adm_no || '–')}</b></div>
      <div><span>Assessment no.</span><b>${esc(x.assessment_no || '–')}</b></div>
      <div><span>Grade</span><b>${esc(r.class.label.replace(/^Grade /, ''))}</b></div>
      <div><span>Class teacher</span><b>${esc(r.class.class_teacher || '–')}</b></div>
    </div>
    <h3>Performance by learning area</h3>
    <table class="perf"><colgroup><col style="width:34mm">${r.columns.map(() => '<col style="width:11.5mm">').join('')}<col style="width:13mm"><col style="width:12mm"><col><col style="width:11mm"></colgroup>
      <thead><tr><th style="text-align:left">Learning area</th>${r.columns.map(c => `<th class="num">${esc(c.label)}<br>%</th>`).join('')}
        <th class="num">Term<br>average</th><th class="num">Level</th><th style="text-align:left">Teacher's comment</th><th class="num">Init.</th></tr></thead>
      <tbody>
        ${r.areas.map(a => { const v = x.areas[a.id]; return `<tr><td>${esc(a.name)}</td>
          ${r.columns.map(c => { const cell = v.cells[c.kind]; return `<td class="num">${!cell ? '' : cell.absent ? '<span class="abs">ABS</span>' : Math.round(cell.percent * 10) / 10}</td>`; }).join('')}
          <td class="num avg">${v.average ?? ''}</td><td class="num">${rfPill(v.level)}</td>
          <td class="comment">${esc(v.comment || '')}</td><td class="num">${esc(v.teacher_initials || '')}</td></tr>`; }).join('')}
        <tr class="overall"><td>OVERALL</td><td colspan="${r.columns.length}"></td><td class="num">${x.overall_percent ?? ''}</td><td class="num">${rfPill(x.overall_level)}</td><td colspan="2"></td></tr>
      </tbody></table>
    <div class="note">ABS = absent: left out of the average, not counted as zero. Each assessment type counts once in the term average, and the overall average gives each learning area equal weight. CBC learners are not ranked.</div>
    <div class="grid2">
      <div class="box summary">
        <div><div class="big">${pct(x.overall_percent)}</div><div style="margin-top:4px">${rfPill(x.overall_level)}</div><div style="margin-top:3px;color:#4f5b55">${esc(x.overall_label || '')}</div></div>
        <div class="side">
          <div>Meeting expectations or above in <b>${x.meeting} of ${x.assessed_areas}</b> learning areas.</div>
          ${x.strongest.length ? `<div><b>Strongest:</b> ${esc(x.strongest.join(', '))}.</div>` : ''}
          ${x.needs_support.length ? `<div><b>Needs support:</b> ${esc(x.needs_support.join(', '))}.</div>` : ''}
          ${x.weak_strands.length ? `<div><b>Strands to work on:</b> ${esc(x.weak_strands.map(s => s.label).join('; '))}.</div>` : ''}
          ${extra.join('')}
        </div>
      </div>
      <table class="key"><thead><tr><th colspan="4" style="text-align:left">Key to performance levels (CBC)</th></tr></thead><tbody>
        ${pairs.map(p => `<tr>${p.map(l => `<td class="num">${rfPill(l.code)}</td><td>${l.range}</td>`).join('')}</tr>`).join('')}
        <tr><td colspan="4" style="font-size:8.5px;color:#5e6a63">${Object.entries(LEVEL_NAMES).map(([k, v]) => `${k} ${v.split(' ')[0]}`).join(' · ')} Expectations</td></tr>
      </tbody></table>
    </div>
    <div class="comments">
      <div><h3>Class teacher's comment</h3><div class="comment-box">${esc(x.class_comment)}<div class="by">${esc(r.class.class_teacher || '')}${r.class.class_teacher ? ', ' : ''}Class teacher</div></div></div>
      <div><h3>Head teacher's comment</h3><div class="comment-box">${esc(x.head_comment)}<div class="by">${esc(sch.head_teacher_name || '')}${sch.head_teacher_name ? ', ' : ''}Head teacher</div></div></div>
    </div>
    <div class="sign"><div>Class teacher's signature</div><div>Head teacher's signature</div><div>Parent / guardian's signature</div><div class="stamp">School stamp</div></div>
    <div class="dates"><span>Closing date: <b>${esc(longDate(r.term_record.closing_date))}</b></span><span>Next term begins: <b>${esc(longDate(r.term_record.next_term_date))}</b></span></div>
    <div class="foot"><span>Levels follow the CBC ${key.id === 'cbc8' ? '8' : '4'}-level rubric. Report generated from the school's assessment records.</span><span>Tathmini CBC</span></div>
  </section>`;
}

async function renderReportForms() {
  const q = hashParams();
  const sel = { class: q.get('class'), term: q.get('term'), year: q.get('year'), learner: q.get('learner') };
  const r = await api('GET', `/api/reports/termly?class_id=${sel.class}&year=${sel.year}&term=${sel.term}${sel.learner ? `&learner_id=${sel.learner}` : ''}`);
  view().innerHTML = `
    <div class="report-bar no-print">
      <a href="#reports?class=${sel.class}&term=${sel.term}&year=${sel.year}">← Report forms</a><span style="flex:1"></span>
      <span class="muted">${r.reports.length} report form${r.reports.length === 1 ? '' : 's'} · choose “Save as PDF” in the print window to download</span>
      <button id="print">Print / Download PDF</button>
    </div>
    ${r.reports.map(x => reportForm(x, r)).join('') || '<p class="muted">No results for this class and term yet.</p>'}`;
  $('#print').onclick = () => {
    const before = document.title;
    document.title = sel.learner && r.reports[0] ? `Report - ${r.reports[0].name} - Term ${sel.term} ${sel.year}` : `Reports - ${r.class.label} - Term ${sel.term} ${sel.year}`;
    window.print();
    document.title = before;
  };
}

// ---------- Classes and learners ----------

async function renderClasses() {
  const [classes, allStaff] = await Promise.all([api('GET', '/api/classes'), api('GET', '/api/staff')]);
  const staff = allStaff.filter(x => x.active);
  view().innerHTML = `
    <h1>Classes & learners</h1>
    <div class="card">
      <form id="f" class="inline">
        <label>Grade <select name="grade">${GRADES.map(g => `<option value="${g}" ${g === 7 ? 'selected' : ''}>${gradeLabel(g)}</option>`).join('')}</select></label>
        <label>Stream <input name="stream" placeholder="e.g. East"></label>
        <label>Year <input name="year" type="number" value="${thisYear}" style="width:90px"></label>
        <label>Class teacher <select name="class_teacher_id"><option value="">–</option>${staff.map(s => `<option value="${s.id}">${esc(s.full_name)}</option>`).join('')}</select></label>
        <button>Add class</button>
      </form>
      <div id="m"></div>
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th>Class</th><th>Class teacher</th><th class="num">Learners</th><th></th></tr></thead>
      <tbody>${classes.map(c => `<tr><td><a href="#class/${c.id}">${esc(classLabel(c))}</a></td><td>${esc(c.staff?.full_name || '–')}</td>
        <td class="num">${c.learners?.[0]?.count ?? 0}</td><td><button class="danger" data-del="${c.id}">Delete</button></td></tr>`).join('') || '<tr><td colspan="4" class="muted">No classes yet.</td></tr>'}</tbody>
    </table></div>`;
  const f = $('#f');
  f.onsubmit = action($('button', f), $('#m'), async () => { await api('POST', '/api/classes', Object.fromEntries(new FormData(f))); route(); });
  $$('[data-del]').forEach(b => {
    b.onclick = action(b, $('#m'), async () => {
      if (!confirm('Delete this class? Its assessments and results are deleted too; learners are kept without a class.')) return;
      await api('DELETE', `/api/classes/${b.dataset.del}`);
      route();
    });
  });
}

function parseLearnerRows(text) {
  const lines = text.trim().split(/\r?\n/).filter(l => l.trim());
  const split = l => (l.includes('\t') ? l.split('\t') : l.split(',')).map(x => x.trim().replace(/^"|"$/g, ''));
  const cols = ['adm_no', 'assessment_no', 'first_name', 'last_name', 'gender', 'parent_name', 'parent_phone'];
  const first = split(lines[0] || '').map(h => h.toLowerCase().replace(/\s+/g, '_'));
  const hasHeader = first.includes('first_name');
  const header = hasHeader ? first : cols;
  return (hasHeader ? lines.slice(1) : lines).map(l => {
    const v = split(l);
    return Object.fromEntries(header.map((h, i) => [h, v[i] || '']));
  });
}

async function renderClass(id) {
  const [classes, learners, staff, billing] = await Promise.all([api('GET', '/api/classes'), api('GET', `/api/learners?class_id=${id}`), api('GET', '/api/staff'), api('GET', '/api/billing')]);
  const cls = classes.find(c => c.id === id);
  const activeStaff = staff.filter(s => s.active);
  const nextLabel = `${gradeLabel(cls.grade + 1)}${cls.stream ? ' ' + cls.stream : ''} (${cls.year + 1})`;
  view().innerHTML = `
    <p><a href="#classes">← Classes</a></p>
    <h1>${esc(classLabel(cls))}</h1>
    <div class="card">
      <form id="ct" class="inline">
        <label>Class teacher <select name="class_teacher_id"><option value="">–</option>${activeStaff.map(s => `<option value="${s.id}" ${cls.class_teacher_id === s.id ? 'selected' : ''}>${esc(s.full_name)}</option>`).join('')}</select></label>
        <button class="secondary">Save</button>
      </form>
      <div class="row" style="margin-top:12px">
        ${cls.grade < 12 && learners.length ? `<button class="secondary" id="promote">Promote all ${learners.length} to ${esc(nextLabel)}</button>` : ''}
        ${learners.length ? '<button class="secondary" id="complete">Learners have finished school</button>' : ''}
      </div>
      <div id="cm" style="margin-top:8px"></div>
    </div>
    <div class="card">
      <strong>Add learners</strong>
      <p class="muted">Paste from Excel or Google Sheets, one learner per line, in this order:
        <code>adm_no, assessment_no, first_name, last_name, gender (F/M), parent_name, parent_phone</code>.
        Existing ADM numbers are updated, e.g. when moving learners to a new class. After adding, pay for new learners from the
        account balance (now ${money(billing.balance_cents)}): <strong>${money(billing.prices.term_cents)} per term</strong> or
        <strong>${money(billing.prices.year_cents)} for the year</strong>.</p>
      <textarea id="csv" class="mono" placeholder="1021, A001021, Amani, Otieno, F, Grace Otieno, 0712345678"></textarea>
      <p><button id="import">Add learners</button></p>
      <div id="m"></div>
      <div id="pay"></div>
    </div>
    <h2>Learners (${learners.length})</h2>
    <div id="lm"></div>
    <div class="table-wrap"><table>
      <thead><tr><th>ADM</th><th>Assessment no.</th><th>Learner</th><th>Gender</th><th>Parent</th><th>Phone</th><th></th></tr></thead>
      <tbody>${learners.map(l => `<tr data-row="${l.id}"><td>${esc(l.adm_no)}</td><td>${esc(l.assessment_no || '')}</td><td>${esc(l.first_name)} ${esc(l.last_name)}</td>
        <td>${esc(l.gender || '')}</td><td>${esc(l.parent_name || '')}</td><td>${esc(l.parent_phone || '')}</td>
        <td class="row" style="flex-wrap:nowrap"><button class="secondary" data-edit="${l.id}">Edit</button><button class="danger" data-remove="${l.id}">Remove</button></td></tr>`).join('')
        || '<tr><td colspan="7" class="muted">No learners yet.</td></tr>'}</tbody>
    </table></div>`;

  const ct = $('#ct');
  ct.onsubmit = action($('button', ct), $('#cm'), async () => { await api('PATCH', `/api/classes/${id}`, Object.fromEntries(new FormData(ct))); notice($('#cm'), null, 'Class teacher saved.'); });
  if ($('#promote')) {
    $('#promote').onclick = action($('#promote'), $('#cm'), async () => {
      if (!confirm(`Move all ${learners.length} learners from ${classLabel(cls)} to ${nextLabel}? Their results and this class's report forms stay available.`)) return;
      const out = await api('POST', `/api/classes/${id}/promote`, { mode: 'promote' });
      location.hash = `#class/${out.class.id}`;
    });
  }
  if ($('#complete')) {
    $('#complete').onclick = action($('#complete'), $('#cm'), async () => {
      if (!confirm(`Mark all ${learners.length} learners in ${classLabel(cls)} as having finished school? They will no longer appear in lists, but their results and report forms are kept.`)) return;
      const out = await api('POST', `/api/classes/${id}/promote`, { mode: 'complete' });
      await route();
      notice($('#cm'), null, `${out.completed} learner(s) marked as finished.`);
    });
  }
  $('#import').onclick = action($('#import'), $('#m'), async () => {
    const rows = parseLearnerRows($('#csv').value);
    if (!rows.length) throw new Error('Paste at least one learner');
    const out = await api('POST', '/api/learners', { class_id: id, learners: rows });
    await route();
    notice($('#m'), null, `${out.saved} learner(s) saved${out.added ? `, ${out.added} new` : ''}.`);
    if (out.added) payPrompt($('#pay'), out.added_ids, `You added ${out.added} new learner${out.added === 1 ? '' : 's'}. Pay now?`);
  });

  // Edit a learner in place; changing the class moves them.
  $$('[data-edit]').forEach(b => {
    b.onclick = () => {
      const l = learners.find(x => x.id === b.dataset.edit);
      const row = $(`[data-row="${l.id}"]`);
      row.innerHTML = `<td colspan="7"><form class="inline" data-form>
        <label>ADM <input name="adm_no" value="${esc(l.adm_no || '')}" style="width:80px"></label>
        <label>Assessment no. <input name="assessment_no" value="${esc(l.assessment_no || '')}" style="width:110px"></label>
        <label>First name <input name="first_name" value="${esc(l.first_name)}" required style="width:120px"></label>
        <label>Last name <input name="last_name" value="${esc(l.last_name)}" required style="width:120px"></label>
        <label>Gender <select name="gender"><option value="">–</option><option ${l.gender === 'F' ? 'selected' : ''}>F</option><option ${l.gender === 'M' ? 'selected' : ''}>M</option></select></label>
        <label>Parent <input name="parent_name" value="${esc(l.parent_name || '')}" style="width:140px"></label>
        <label>Phone <input name="parent_phone" value="${esc(l.parent_phone || '')}" style="width:130px"></label>
        <label>Class <select name="class_id">${classes.map(c => `<option value="${c.id}" ${c.id === id ? 'selected' : ''}>${esc(classLabel(c))}</option>`).join('')}</select></label>
        <button>Save</button><button type="button" class="secondary" data-cancel>Cancel</button>
      </form><div data-msg></div></td>`;
      const f = $('[data-form]', row);
      $('[data-cancel]', row).onclick = () => route();
      f.onsubmit = action($('button', f), $('[data-msg]', row), async () => {
        await api('PATCH', `/api/learners/${l.id}`, Object.fromEntries(new FormData(f)));
        route();
      });
    };
  });
  $$('[data-remove]').forEach(b => {
    b.onclick = action(b, $('#lm'), async () => {
      const l = learners.find(x => x.id === b.dataset.remove);
      if (!confirm(`Remove ${l.first_name} ${l.last_name}? Use this when a learner has left the school. Their past results and report forms are kept.`)) return;
      await api('PATCH', `/api/learners/${l.id}`, { active: false });
      route();
    });
  });
}

// ---------- Teachers and their learning areas ----------

async function renderTeachers() {
  const [staff, classes, areas, assignments] = await Promise.all([api('GET', '/api/staff'), api('GET', '/api/classes'), api('GET', '/api/curriculum'), api('GET', '/api/assignments')]);
  const opts = (xs, label) => xs.map(x => `<option value="${x.id}">${esc(label(x))}</option>`).join('');
  const active = staff.filter(s => s.active);
  const removed = staff.filter(s => !s.active);
  const orphaned = assignments.filter(a => a.staff && a.staff.active === false);
  const staffRow = s => `<tr data-row="${s.id}"><td>${esc(s.full_name)}</td><td>${esc(s.email)}</td><td>${esc(s.phone || '')}</td>
    <td>${s.role === 'admin' ? 'Admin' : 'Teacher'}</td>
    <td class="row" style="flex-wrap:nowrap">${s.active
      ? `<button class="secondary" data-edit="${s.id}">Edit</button>${s.id === S.staff.id ? '' : `<button class="danger" data-remove="${s.id}">Remove</button>`}`
      : `<button class="secondary" data-restore="${s.id}">Restore</button>`}</td></tr>`;
  view().innerHTML = `
    <h1>Teachers</h1>
    <div class="card">
      <form id="inv" class="inline">
        <label>Full name <input name="full_name" required></label>
        <label>Gmail (sheets are shared with it) <input name="email" type="email" required></label>
        <label>Phone <input name="phone"></label>
        <label>Role <select name="role"><option value="teacher">Teacher (fills sheets only)</option><option value="admin">Admin (signs in, e.g. ICT)</option></select></label>
        <button>Add</button>
      </form>
      <div id="m1"></div>
    </div>
    <div id="sm"></div>
    <div class="table-wrap"><table>
      <thead><tr><th>Name</th><th>Email</th><th>Phone</th><th>Role</th><th></th></tr></thead>
      <tbody>${active.map(staffRow).join('')}</tbody>
    </table></div>
    ${removed.length ? `<h2 class="muted">Removed (${removed.length})</h2><div class="table-wrap"><table class="muted"><tbody>${removed.map(staffRow).join('')}</tbody></table></div>` : ''}
    <h2>Who teaches what</h2>
    ${orphaned.length ? `<div class="notice error">${orphaned.length} learning area(s) belong to a removed teacher: ${orphaned.map(a => `${esc(a.learning_areas.name)} in ${esc(classLabel(a.classes))}`).join('; ')}. Assign them to another teacher below.</div>` : ''}
    <div class="card">
      <form id="asg" class="inline">
        <label>Teacher <select name="teacher_id">${opts(active, s => s.full_name)}</select></label>
        <label>Class <select name="class_id">${opts(classes, classLabel)}</select></label>
        <label>Learning area <select name="learning_area_id"></select></label>
        <button>Assign</button>
      </form>
      <p class="muted" style="margin-bottom:0">Assigning a learning area that already has a teacher in that class hands it over to the new teacher.</p>
      <div id="m2"></div>
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th>Class</th><th>Learning area</th><th>Teacher</th><th></th></tr></thead>
      <tbody>${assignments.sort((a, b) => classLabel(a.classes).localeCompare(classLabel(b.classes)) || a.learning_areas.name.localeCompare(b.learning_areas.name)).map(x => `<tr>
        <td>${esc(classLabel(x.classes))}</td><td>${esc(x.learning_areas.name)}</td>
        <td>${esc(x.staff.full_name)}${x.staff.active === false ? ' <span class="pill" style="color:var(--danger)">removed</span>' : ''}</td>
        <td><button class="danger" data-del="${x.id}">Remove</button></td></tr>`).join('') || '<tr><td colspan="4" class="muted">No assignments yet.</td></tr>'}</tbody>
    </table></div>`;

  const inv = $('#inv');
  inv.onsubmit = action($('button', inv), $('#m1'), async () => {
    const out = await api('POST', '/api/staff', Object.fromEntries(new FormData(inv)));
    await route();
    notice($('#m1'), null, out.staff.role === 'admin' ? 'Admin added and sent a sign-in email.' : 'Teacher added. Assign their learning areas below.');
  });
  $$('[data-edit]').forEach(b => {
    b.onclick = () => {
      const t = staff.find(x => x.id === b.dataset.edit);
      const row = $(`[data-row="${t.id}"]`);
      row.innerHTML = `<td colspan="5"><form class="inline" data-form>
        <label>Full name <input name="full_name" value="${esc(t.full_name)}" required></label>
        <label>Gmail <input name="email" type="email" value="${esc(t.email)}" required></label>
        <label>Phone <input name="phone" value="${esc(t.phone || '')}"></label>
        <label>Role <select name="role" ${t.id === S.staff.id ? 'disabled' : ''}><option value="teacher" ${t.role === 'teacher' ? 'selected' : ''}>Teacher</option><option value="admin" ${t.role === 'admin' ? 'selected' : ''}>Admin</option></select></label>
        <button>Save</button><button type="button" class="secondary" data-cancel>Cancel</button>
      </form><p class="muted" style="margin:6px 0 0">A new Gmail only applies to sheets sent from now on.</p><div data-msg></div></td>`;
      const f = $('[data-form]', row);
      $('[data-cancel]', row).onclick = () => route();
      f.onsubmit = action($('button', f), $('[data-msg]', row), async () => {
        await api('PATCH', `/api/staff/${t.id}`, Object.fromEntries(new FormData(f)));
        route();
      });
    };
  });
  $$('[data-remove]').forEach(b => {
    b.onclick = action(b, $('#sm'), async () => {
      const t = staff.find(x => x.id === b.dataset.remove);
      const theirs = assignments.filter(a => a.teacher_id === t.id).length;
      if (!confirm(`Remove ${t.full_name}? Use this when they leave.${theirs ? ` Their ${theirs} learning area(s) will need a new teacher.` : ''}`)) return;
      await api('PATCH', `/api/staff/${t.id}`, { active: false });
      route();
    });
  });
  $$('[data-restore]').forEach(b => { b.onclick = action(b, $('#sm'), async () => { await api('PATCH', `/api/staff/${b.dataset.restore}`, { active: true }); route(); }); });
  const asg = $('#asg');
  const fillAreas = () => {
    const cls = classes.find(c => c.id === asg.class_id.value);
    asg.learning_area_id.innerHTML = cls ? opts(areas.filter(a => a.grades.includes(cls.grade)), a => a.name) : '';
  };
  asg.class_id.onchange = fillAreas;
  fillAreas();
  asg.onsubmit = action($('button', asg), $('#m2'), async () => { await api('POST', '/api/assignments', Object.fromEntries(new FormData(asg))); route(); });
  $$('[data-del]').forEach(b => { b.onclick = action(b, $('#m2'), async () => { await api('DELETE', `/api/assignments/${b.dataset.del}`); route(); }); });
}

// ---------- Curriculum (read-only for schools; the owner imports it) ----------

async function renderCurriculum() {
  const q = hashParams();
  const grade = q.has('grade') ? Number(q.get('grade')) : 7;
  const areas = await api('GET', `/api/curriculum?grade=${grade}`);
  const owner = S.isOwner;
  view().innerHTML = `
    <h1>${owner ? 'National curriculum' : 'Curriculum'}</h1>
    <p class="muted">${owner ? 'Learning areas, strands and sub-strands used by every school. Keep this in line with the KICD curriculum designs.'
      : 'Learning areas, strands and sub-strands from the national CBC curriculum; the same for every school.'}</p>
    <div class="row" style="margin-bottom:12px">${GRADES.map(g => `<a class="btn ${g === grade ? '' : 'secondary'}" href="#curriculum?grade=${g}">${gradeLabel(g)}</a>`).join('')}</div>
    ${owner ? `
    <div class="card">
      <h2 style="margin-top:0">Import from the curriculum designs</h2>
      <p class="muted">Paste spreadsheet rows with the columns <code>grade, learning_area, code, strand, sub_strand</code>, one row per sub-strand,
        e.g. <code>Grade 7, Mathematics, MAT, Numbers, Fractions</code>. For each learning area and grade in the import, its strands are replaced.</p>
      <textarea id="csv" class="mono" placeholder="grade,learning_area,code,strand,sub_strand"></textarea>
      <div class="row" style="margin-top:8px">
        <button class="secondary" id="check">Check</button><button id="import">Import</button><span style="flex:1"></span>
        <button class="secondary" id="starter">Load starter curriculum</button><button class="secondary" id="export">Download as CSV</button>
      </div>
      <div id="im" style="margin-top:8px"></div>
    </div>` : ''}
    <div id="m"></div>
    ${areas.map(a => `
      <div class="card">
        <div class="row"><strong>${esc(a.name)}</strong> <span class="muted">${esc(a.code || '')}</span>
          ${owner ? `<span style="flex:1"></span><label class="check">Code <input data-code="${a.id}" value="${esc(a.code || '')}" maxlength="4" style="width:70px"></label>` : ''}</div>
        ${a.strands.length ? `<ol style="margin:8px 0 0;padding-left:20px">${a.strands.map(st => `<li>${esc(st.name)}${st.sub_strands.length ? `<div class="muted">${st.sub_strands.map(ss => esc(ss.name)).join(' · ')}</div>` : ''}</li>`).join('')}</ol>`
          : `<p class="muted" style="margin:6px 0 0">Strands not loaded yet.</p>`}
      </div>`).join('') || `<p class="muted">No learning areas for ${gradeLabel(grade)} yet.</p>`}`;
  if (!owner) return;
  const im = $('#im');
  $('#check').onclick = action($('#check'), im, async () => {
    const out = await api('POST', '/api/curriculum/import', { csv: $('#csv').value, dry_run: true });
    notice(im, null, `Looks good: ${out.rows} rows, ${out.summary.map(a => `${a.name} (${a.strands} strands)`).join(', ')}.`);
  });
  $('#import').onclick = action($('#import'), im, async () => {
    const out = await api('POST', '/api/curriculum/import', { csv: $('#csv').value });
    await route();
    notice($('#im'), null, `Imported ${out.rows} rows: ${out.areas_added} new learning areas, ${out.areas_updated} updated, ${out.strands} strands, ${out.sub_strands} sub-strands.`);
  });
  $('#starter').onclick = action($('#starter'), im, async () => {
    if (!confirm('Load the starter curriculum (CBC learning areas PP1–Grade 9 and some Junior School strands)?')) return;
    const out = await api('POST', '/api/curriculum/import', { starter: true });
    await route();
    notice($('#im'), null, `Starter curriculum loaded: ${out.areas_added} new learning areas, ${out.strands} strands. Check the strands against the KICD designs.`);
  });
  $('#export').onclick = action($('#export'), im, async () => {
    const { csv } = await api('GET', '/api/curriculum/export');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = 'cbc-curriculum.csv';
    a.click();
  });
  $$('[data-code]').forEach(i => {
    i.onchange = async () => {
      try { await api('PATCH', `/api/curriculum/areas/${i.dataset.code}`, { code: i.value }); notice($('#m'), null, 'Saved.'); } catch (err) { notice($('#m'), err); }
    };
  });
}

// Resizes an image file in the browser so the stored logo stays small; keeps transparency (PNG).
function shrinkImage(file, size) {
  return new Promise((resolve, reject) => {
    if (!/^image\//.test(file.type)) return reject(new Error('Choose an image file (PNG or JPEG)'));
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, size / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      const png = canvas.toDataURL('image/png');
      resolve(png.length < 300 * 1024 ? png : canvas.toDataURL('image/jpeg', 0.85));
      URL.revokeObjectURL(img.src);
    };
    img.onerror = () => reject(new Error('That image could not be read'));
    img.src = URL.createObjectURL(file);
  });
}

// ---------- Settings: Google, school details, billing, grading ----------

async function renderSettings() {
  await loadMe();
  const s = S.school;
  const flag = hashParams().get('google');
  const bq = hashParams();
  const b = await api('GET', `/api/billing${bq.get('term') ? `?term=${bq.get('term')}&year=${bq.get('year')}` : ''}`);
  view().innerHTML = `
    <h1>Settings</h1>
    ${flag === 'connected' ? '<div class="notice">Google account connected.</div>' : flag ? `<div class="notice error">Google connection failed: ${esc(flag)}</div>` : ''}
    <div class="card">
      <h2 style="margin-top:0">Google Sheets</h2>
      ${s.google_connected
        ? `<p>Connected as <strong>${esc(s.google_email || 'Google account')}</strong>. Score sheets are created in this account and shared with each teacher.</p><button class="secondary" id="gdis">Disconnect</button>`
        : '<p>Connect the school Google account. Score sheets will be created there and shared with teachers by Gmail.</p><button id="gcon">Connect Google</button>'}
      <div id="gm"></div>
    </div>
    <div class="card">
      <h2 style="margin-top:0">School details <span class="muted" style="font-weight:400;font-size:14px">(printed on report forms)</span></h2>
      <form id="f">
        <div class="grid">
          <label>School name <input name="name" value="${esc(s.name)}"></label>
          <label>Short name <input name="short_name" value="${esc(s.short_name || '')}"></label>
          <label>County <input name="county" value="${esc(s.county || '')}"></label>
          <label>Postal address <input name="address" value="${esc(s.address || '')}" placeholder="P.O. Box …"></label>
          <label>Phone <input name="phone" value="${esc(s.phone || '')}"></label>
          <label>Email <input name="email" value="${esc(s.email || '')}"></label>
          <label>Motto <input name="motto" value="${esc(s.motto || '')}"></label>
          <label>Head teacher's name <input name="head_teacher_name" value="${esc(s.head_teacher_name || '')}" placeholder="e.g. Mr P. Kamau"></label>
        </div>
        <p><button>Save</button></p>
      </form>
      <div id="m"></div>
      <h2>School logo</h2>
      <div class="row">
        ${s.logo ? `<img src="${esc(s.logo)}" alt="School logo" style="width:72px;height:72px;object-fit:contain;border:1px solid var(--border);border-radius:8px;background:#fff">` : '<span class="muted">No logo yet: report forms show the school\'s initials.</span>'}
        <label class="btn secondary" style="flex-direction:row;color:var(--accent)">${s.logo ? 'Change logo' : 'Upload logo'}<input type="file" id="logo" accept="image/*" hidden></label>
        ${s.logo ? '<button class="danger" id="nologo">Remove logo</button>' : ''}
      </div>
      <div id="lm"></div>
    </div>
    <div class="card">
      <h2 style="margin-top:0">Billing</h2>
      <div class="grid">
        <div class="stat"><div class="v">${money(b.balance_cents)}</div><div class="k">Account balance</div></div>
        <div class="stat"><div class="v">${b.paid}/${b.learners}</div><div class="k">Learners paid for Term ${b.term} ${b.year}</div></div>
        <div class="stat"><div class="v">${money(b.prices.term_cents)} / ${money(b.prices.year_cents)}</div><div class="k">Per learner: one term / whole year</div></div>
      </div>
      <p class="muted">To add to the balance, pay the Tathmini team (e.g. by M-Pesa); they credit your account and it shows below.
        Paying for the year after some terms are paid only charges for the terms left (never more than ${money(b.prices.year_cents)} a year).</p>
      <form id="bp" class="inline">
        <label>Term <select name="term">${[1, 2, 3].map(t => `<option value="${t}" ${t === b.term ? 'selected' : ''}>Term ${t}</option>`).join('')}</select></label>
        <label>Year <input name="year" type="number" value="${b.year}" style="width:90px"></label>
        <button class="secondary">Show</button>
      </form>
      <div id="bpay" style="margin-top:12px"></div>
      <div id="bm"></div>
      ${b.ledger.length ? `<h2>Account activity</h2><div class="table-wrap"><table>
        <thead><tr><th>Date</th><th>Details</th><th class="num">Amount</th><th class="num">Balance</th></tr></thead>
        <tbody>${b.ledger.map(l => `<tr><td>${esc(new Date(l.created_at).toLocaleDateString('en-KE'))}</td><td>${esc(l.reason)}</td>
          <td class="num">${l.change_cents > 0 ? '+' : '−'}${money(Math.abs(l.change_cents))}</td><td class="num">${money(l.balance_after_cents)}</td></tr>`).join('')}</tbody></table></div>` : ''}
    </div>
    <div class="card">
      <h2 style="margin-top:0">Grading thresholds</h2>
      <p class="muted">Minimum percentage for each level. Leave blank to use the defaults shown.</p>
      <form id="gr">
        <p><strong>PP1–Grade 6</strong></p>
        <div class="inline">${[['EE', 80], ['ME', 50], ['AE', 30]].map(([k, d]) => `<label>${k} <input name="cbc4.${k}" type="number" min="0" max="100" placeholder="${d}" value="${esc(s.grading?.cbc4?.[k] ?? '')}" style="width:80px"></label>`).join('')}</div>
        <p><strong>Grade 7–9</strong></p>
        <div class="inline">${[['EE1', 90], ['EE2', 75], ['ME1', 58], ['ME2', 41], ['AE1', 31], ['AE2', 21], ['BE1', 11]].map(([k, d]) => `<label>${k} <input name="cbc8.${k}" type="number" min="0" max="100" placeholder="${d}" value="${esc(s.grading?.cbc8?.[k] ?? '')}" style="width:70px"></label>`).join('')}</div>
        <p><button>Save thresholds</button></p>
      </form>
      <div id="grm"></div>
    </div>`;
  $('#logo').onchange = async e => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const logo = await shrinkImage(file, 300);
      await api('PATCH', '/api/school', { logo });
      await loadMe();
      route();
    } catch (err) { notice($('#lm'), err); }
  };
  if ($('#nologo')) $('#nologo').onclick = action($('#nologo'), $('#lm'), async () => { await api('PATCH', '/api/school', { logo: null }); await loadMe(); route(); });
  if ($('#gcon')) $('#gcon').onclick = action($('#gcon'), $('#gm'), async () => { location.href = (await api('GET', '/api/google/connect')).url; });
  if ($('#gdis')) $('#gdis').onclick = action($('#gdis'), $('#gm'), async () => { await api('POST', '/api/google/disconnect'); route(); });
  const f = $('#f');
  f.onsubmit = action($('button', f), $('#m'), async () => { await api('PATCH', '/api/school', Object.fromEntries(new FormData(f))); await loadMe(); notice($('#m'), null, 'Saved.'); });
  const bp = $('#bp');
  bp.onsubmit = e => { e.preventDefault(); const fd = Object.fromEntries(new FormData(bp)); location.hash = `#settings?term=${fd.term}&year=${fd.year}`; };
  if (b.unpaid.length) {
    payPrompt($('#bpay'), 'unpaid', `${b.unpaid.length} learner(s) not paid for Term ${b.term} ${b.year}: ${b.unpaid.slice(0, 8).map(l => l.name).join(', ')}${b.unpaid.length > 8 ? '…' : ''}`, { term: b.term, year: b.year });
  } else {
    $('#bpay').innerHTML = `<p class="muted">All ${b.learners} learners are paid for Term ${b.term} ${b.year}.</p>`;
  }
  const gr = $('#gr');
  gr.onsubmit = action($('button', gr), $('#grm'), async () => {
    const grading = { cbc4: {}, cbc8: {} };
    for (const [k, v] of new FormData(gr)) { const [scale, code] = k.split('.'); if (v !== '') grading[scale][code] = Number(v); }
    await api('PATCH', '/api/school', { grading });
    await loadMe();
    notice($('#grm'), null, 'Thresholds saved. They apply the next time an assessment is analysed.');
  });
}

// Offers to pay for learners by the term or the year, showing both prices first.
// learnerIds: an array of ids, or 'unpaid' for every unpaid learner.
async function payPrompt(box, learnerIds, message, period = {}) {
  const term = period.term || thisTerm;
  const year = period.year || thisYear;
  const [qt, qy] = await Promise.all(['term', 'year'].map(plan => api('POST', '/api/billing/quote', { learner_ids: learnerIds, term, year, plan })));
  if (!qt.learners && !qy.learners) { box.innerHTML = ''; return; }
  box.innerHTML = `
    <div class="card" style="border-color:var(--accent)">
      <p style="margin-top:0">${esc(message)}</p>
      <div class="row">
        ${qt.learners ? `<button data-plan="term">Pay for Term ${term} · ${money(qt.total_cents)}</button>` : ''}
        ${qy.learners ? `<button data-plan="year" class="secondary">Pay for the whole of ${year} · ${money(qy.total_cents)}</button>` : ''}
        <button class="secondary" data-later>Later</button>
      </div>
      <div data-msg style="margin-top:8px"></div>
    </div>`;
  const msg = $('[data-msg]', box);
  $('[data-later]', box).onclick = () => { box.innerHTML = '<p class="muted">Not paid yet: these learners are left out of sheets and report forms until paid for (Settings → Billing).</p>'; };
  $$('[data-plan]', box).forEach(btn => {
    btn.onclick = action(btn, msg, async () => {
      const out = await api('POST', '/api/billing/pay', { learner_ids: learnerIds, term, year, plan: btn.dataset.plan });
      box.innerHTML = `<div class="notice">Paid for ${out.learners} learner(s): ${money(out.charged_cents)}. Balance now ${money(out.balance_cents)}.</div>`;
    });
  });
}

// ---------- Owner: all schools ----------

async function renderSchools() {
  const schools = await api('GET', '/api/owner/schools');
  view().innerHTML = `
    <h1>All schools</h1>
    <div class="grid">
      <div class="stat"><div class="v">${schools.length}</div><div class="k">Schools</div></div>
      <div class="stat"><div class="v">${schools.reduce((n, x) => n + x.learners, 0).toLocaleString()}</div><div class="k">Learners</div></div>
      <div class="stat"><div class="v">${schools.reduce((n, x) => n + x.learners_paid_this_term, 0).toLocaleString()}</div><div class="k">Learners paid for Term ${thisTerm} ${thisYear}</div></div>
    </div>
    <div id="m" style="margin-top:12px"></div>
    <div class="table-wrap"><table>
      <thead><tr><th>School</th><th>Contact</th><th class="num">Learners (paid this term)</th><th class="num">Balance</th><th>Record a payment or correction</th></tr></thead>
      <tbody>${schools.map(x => `<tr>
        <td><strong>${esc(x.name)}</strong><div class="muted">${esc(x.county || '')}</div></td>
        <td>${esc(x.phone || '')}<div class="muted">${esc(x.email || '')}</div></td>
        <td class="num">${x.learners} <span class="muted">(${x.learners_paid_this_term})</span></td>
        <td class="num">${money(x.balance_cents)}</td>
        <td><form class="row" data-credit="${x.id}"><input name="amount_kes" type="number" step="1" placeholder="KES" style="width:90px" required>
          <input name="reason" placeholder="e.g. M-Pesa QJK2X7" style="width:150px"><button class="secondary">Apply</button></form></td>
      </tr>`).join('') || '<tr><td colspan="5" class="muted">No schools yet.</td></tr>'}</tbody>
    </table></div>`;
  $$('[data-credit]').forEach(form => {
    form.onsubmit = action($('button', form), $('#m'), async () => {
      const fd = Object.fromEntries(new FormData(form));
      const out = await api('POST', `/api/owner/schools/${form.dataset.credit}/balance`, { amount_kes: Number(fd.amount_kes), reason: fd.reason });
      await route();
      setTimeout(() => notice($('#m'), null, `Balance updated: ${money(out.balance_cents)}.`), 200);
    });
  });
}

boot().catch(err => { view().innerHTML = '<div id="m"></div>'; notice($('#m'), err); });
