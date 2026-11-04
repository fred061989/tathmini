// National curriculum import: parsing and validating curriculum rows.
//
// One row per sub-strand (or per strand, or per learning area for a grade):
//   grade, learning_area, code, strand, sub_strand
// e.g. "Grade 7, Mathematics, MAT, Numbers, Fractions". Pure: no database access.

const COLUMNS = ['grade', 'learning_area', 'code', 'strand', 'sub_strand'];

// "PP1", "pp 2", "Grade 7", "G7", "7", -1 → integer grade (PP1 = -1, PP2 = 0)
function parseGrade(v) {
  if (Number.isInteger(v)) return v >= -1 && v <= 12 ? v : null;
  const s = String(v ?? '').trim().toLowerCase().replace(/\s+/g, '');
  if (s === 'pp1') return -1;
  if (s === 'pp2') return 0;
  const m = s.match(/^(?:grade|gr|g)?(\d{1,2})$/);
  if (!m) return null;
  const g = Number(m[1]);
  return g >= 1 && g <= 12 ? g : null;
}

function splitCsvLine(line) {
  if (line.includes('\t')) return line.split('\t').map(x => x.trim());
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"' && quoted && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') quoted = !quoted;
    else if (ch === ',' && !quoted) { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

// CSV or tab-separated text (pasted from Excel / Google Sheets). Header row optional.
function parseCurriculumCsv(text) {
  const lines = String(text || '').split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return [];
  const first = splitCsvLine(lines[0]).map(h => h.toLowerCase().replace(/[\s-]+/g, '_'));
  const hasHeader = first.includes('learning_area');
  const header = hasHeader ? first : COLUMNS;
  return (hasHeader ? lines.slice(1) : lines).map(l => {
    const v = splitCsvLine(l);
    return Object.fromEntries(header.map((h, i) => [h, v[i] ?? '']));
  });
}

/**
 * Validates rows and groups them by learning area:
 * { areas: [{ name, code, grades, strands: { grade: [{ name, subs }] } }], errors }
 * A learning area and grade that appears with strands replaces that grade's strands on import.
 */
function groupCurriculum(rows) {
  const errors = [];
  const areas = new Map();
  rows.forEach((r, i) => {
    const line = i + 1;
    const grade = parseGrade(r.grade);
    const name = String(r.learning_area || '').trim();
    if (grade == null) { errors.push(`Row ${line}: "${r.grade}" is not a grade (use PP1, PP2 or 1–12)`); return; }
    if (!name) { errors.push(`Row ${line}: learning area is missing`); return; }
    const sub = String(r.sub_strand || '').trim();
    const strand = String(r.strand || '').trim();
    if (sub && !strand) { errors.push(`Row ${line}: sub-strand "${sub}" has no strand`); return; }
    const key = name.toLowerCase();
    if (!areas.has(key)) areas.set(key, { name, code: '', grades: new Set(), strands: new Map() });
    const a = areas.get(key);
    if (r.code && !a.code) a.code = String(r.code).trim().toUpperCase().slice(0, 4);
    a.grades.add(grade);
    if (!strand) return;
    if (!a.strands.has(grade)) a.strands.set(grade, []);
    const list = a.strands.get(grade);
    let s = list.find(x => x.name.toLowerCase() === strand.toLowerCase());
    if (!s) { s = { name: strand, subs: [] }; list.push(s); }
    if (sub && !s.subs.some(x => x.toLowerCase() === sub.toLowerCase())) s.subs.push(sub);
  });
  return {
    errors,
    areas: [...areas.values()].map(a => ({
      name: a.name, code: a.code || null, grades: [...a.grades].sort((x, y) => x - y), strands: Object.fromEntries(a.strands),
    })),
  };
}

// Back to CSV rows, for exporting the current curriculum.
function toCsv(areas) {
  const esc = v => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ''));
  const gradeText = g => (g === -1 ? 'PP1' : g === 0 ? 'PP2' : `Grade ${g}`);
  const lines = [COLUMNS.join(',')];
  for (const a of areas) {
    for (const grade of a.grades) {
      const strands = (a.strands || []).filter(s => s.grade === grade).sort((x, y) => x.sort_order - y.sort_order);
      const base = [gradeText(grade), a.name, a.code || ''];
      if (!strands.length) lines.push([...base, '', ''].map(esc).join(','));
      for (const s of strands) {
        const subs = [...(s.sub_strands || [])].sort((x, y) => x.sort_order - y.sort_order);
        if (!subs.length) lines.push([...base, s.name, ''].map(esc).join(','));
        for (const ss of subs) lines.push([...base, s.name, ss.name].map(esc).join(','));
      }
    }
  }
  return lines.join('\n');
}

module.exports = { COLUMNS, parseGrade, parseCurriculumCsv, groupCurriculum, toCsv };
