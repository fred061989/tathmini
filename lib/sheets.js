// Google Sheets integration.
//
// The school admin connects the school's Google account once (OAuth, drive.file scope),
// so every assessment sheet is owned by the school and shared with the teacher.
// drive.file only lets the app touch files it created itself.

const { OAuth2Client } = require('google-auth-library');
const { sheets: sheetsApi } = require('@googleapis/sheets');
const { drive: driveApi } = require('@googleapis/drive');

const SCOPES = ['https://www.googleapis.com/auth/drive.file', 'openid', 'email'];
const SCORES_TAB = 'Scores';
const FIXED_COLS = ['Learner ID', 'ADM No', 'Learner Name'];
// % and Level are worked out by the sheet itself as the teacher types (formulas; locked).
// There is no Absent column: the teacher types AB in any mark cell (a strand or test the learner missed).
const TRAILING_COLS = ['%', 'Level'];
// Row 2 holds what each column is marked out of. The admin fills it in when creating the assessment,
// and the teacher may change it (e.g. a test given out of 50 instead of 20). Percentages use it.
const OUT_OF_LABEL = 'OUT OF →';
const FIRST_LEARNER_ROW = 2; // 0-based: row 3 in the sheet

function oauthClient() {
  return new OAuth2Client(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, `${process.env.APP_URL}/api/google/callback`);
}

function authUrl(state) {
  return oauthClient().generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: SCOPES, state });
}

async function exchangeCode(code) {
  const client = oauthClient();
  const { tokens } = await client.getToken(code);
  let email = null;
  if (tokens.id_token) {
    const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: process.env.GOOGLE_CLIENT_ID });
    email = ticket.getPayload().email;
  }
  return { refreshToken: tokens.refresh_token, email };
}

function authFor(refreshToken) {
  const client = oauthClient();
  client.setCredentials({ refresh_token: refreshToken });
  return client;
}

const componentHeader = c => String(c.label);

// A1-style column letter for a 0-based column index.
function colLetter(i) {
  let n = i + 1;
  let out = '';
  while (n) { const m = (n - 1) % 26; out = String.fromCharCode(65 + m) + out; n = Math.floor((n - 1) / 26); }
  return out;
}

// Pure: the grid a teacher fills in. Column A (learner id) is hidden. `top` is the two heading rows.
function buildSheetLayout({ components, learners }) {
  const header = [...FIXED_COLS, ...components.map(componentHeader), ...TRAILING_COLS];
  const outOf = ['', '', OUT_OF_LABEL, ...components.map(c => Number(c.max_score)), '', ''];
  const rows = learnerRows(components, learners);
  return { header, outOf, top: [header, outOf], rows, scoreStart: FIXED_COLS.length, scoreEnd: FIXED_COLS.length + components.length };
}

function learnerRows(components, learners) {
  return learners.map(l => [l.id, l.adm_no || '', `${l.first_name} ${l.last_name}`.trim(), ...components.map(() => ''), '', '']);
}

// Pure: the % and Level formulas for sheet rows first..last (1-based). levels: [{ code, min }], highest first.
// % = marks scored ÷ "out of" (row 2) of the marks filled in so far (AB marks left out); AB when every mark is AB.
function rowFormulas(components, levels, first, last) {
  const a = colLetter(FIXED_COLS.length);
  const z = colLetter(FIXED_COLS.length + components.length - 1);
  const pct = colLetter(FIXED_COLS.length + components.length);
  const ordered = [...levels].sort((x, y) => y.min - x.min);
  const out = [];
  for (let r = first; r <= last; r++) {
    const range = `${a}${r}:${z}${r}`;
    const p = `${pct}${r}`;
    const level = ordered.slice(0, -1).reduceRight((rest, l) => `IF(${p}>=${l.min},"${l.code}",${rest})`, `"${ordered[ordered.length - 1].code}"`);
    out.push([
      `=IF(COUNT(${range})=0,IF(COUNTIF(${range},"AB")>0,"AB",""),ROUND(SUM(${range})/SUMPRODUCT(ISNUMBER(${range})*${a}$2:${z}$2)*100,1))`,
      `=IF(ISNUMBER(${p}),${level},${p})`,
    ]);
  }
  return { range: `${pct}${first}:${colLetter(FIXED_COLS.length + components.length + 1)}${last}`, values: out };
}

// Pure: reads the teacher's grid back into score rows, and the "out of" marks (row 2).
// Returns { scores, issues, maxScores: [{ component_id, max_score }], outOfErrors }.
function parseSheetValues(values, components, learners) {
  const issues = [];
  const [header = [], outOfRow = [], ...rows] = values || [];
  const start = FIXED_COLS.length;
  components.map(componentHeader).forEach((h, i) => {
    if (String(header[start + i] || '').trim() !== h) {
      issues.push(`Column ${start + i + 1} should be "${h}" but is "${header[start + i] || ''}". Do not edit or reorder header columns.`);
    }
  });
  if (String(outOfRow[start - 1] || '').trim() !== OUT_OF_LABEL) issues.push('Row 2 (the "Out of" row) is missing or was moved. Do not delete or move it.');
  if (issues.length) return { scores: [], issues, maxScores: [], outOfErrors: [] };

  const outOfErrors = [];
  const maxScores = components.map((c, i) => {
    const raw = outOfRow[start + i];
    const v = raw == null || String(raw).trim() === '' ? Number(c.max_score) : Number(raw);
    if (!Number.isFinite(v) || v <= 0 || v > 1000) outOfErrors.push(`"Out of" for ${c.label} must be a number from 1 to 1000 (it is "${raw}")`);
    return { component_id: c.id, max_score: v };
  });

  const known = new Set(learners.map(l => l.id));
  const scores = [];
  const seen = new Set();
  for (const row of rows) {
    const learnerId = String(row[0] || '').trim();
    if (!learnerId) continue;
    if (!known.has(learnerId)) { issues.push(`Row for "${row[2] || learnerId}" is not a learner in this class; skipped.`); continue; }
    seen.add(learnerId);
    components.forEach((c, i) => {
      const raw = row[start + i];
      const text = raw == null ? '' : String(raw).trim();
      const absent = /^(ab|abs|absent)$/i.test(text);
      scores.push({
        learner_id: learnerId, component_id: c.id,
        raw_score: absent ? 'AB' : text === '' ? null : text,
        absent, comment: null,
      });
    });
  }
  const missing = learners.filter(l => !seen.has(l.id)).length;
  if (missing) issues.push(`${missing} learner(s) are not on the sheet (e.g. paid for after it was sent); press "Add newly paid learners to the sheet" to add them.`);
  return { scores, issues, maxScores, outOfErrors };
}

// Score cells accept a number from 0 to the column's "out of" mark in row 2.
function scoreValidation(sheetId, layoutStart, components, startRow, endRow) {
  return components.map((c, i) => {
    const col = layoutStart + i;
    const L = colLetter(col);
    return {
      setDataValidation: {
        range: { sheetId, startRowIndex: startRow, endRowIndex: endRow, startColumnIndex: col, endColumnIndex: col + 1 },
        rule: { condition: { type: 'CUSTOM_FORMULA', values: [{ userEnteredValue: `=OR(UPPER(TRIM(${L}${startRow + 1}))="AB",AND(ISNUMBER(${L}${startRow + 1}),${L}${startRow + 1}>=0,${L}${startRow + 1}<=${L}$2))` }] },
          inputMessage: `A mark from 0 to the "Out of" in row 2, or AB if the learner was absent`, strict: true, showCustomUi: true },
      },
    };
  });
}

// A1 reference to a cell range on a named tab, e.g. 'Maths – G7 East'!A1 (quotes doubled inside the name).
const onTab = (tab, range) => `'${String(tab).replace(/'/g, "''")}'!${range}`;

// Tab names: unique in the workbook, at most 90 characters, none of : \ / ? * [ ].
function tabTitles(names) {
  const used = new Set();
  return names.map(n => {
    const base = String(n).replace(/[:\\/?*[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 90) || 'Scores';
    let t = base;
    for (let i = 2; used.has(t.toLowerCase()); i++) t = `${base.slice(0, 85)} (${i})`;
    used.add(t.toLowerCase());
    return t;
  });
}

// Formatting, locks and checks for one tab.
function tabRequests(sheetId, layout, components, lastRow) {
  return [
    { updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: 1 }, properties: { hiddenByUser: true }, fields: 'hiddenByUser' } },
    { repeatCell: { range: { sheetId, startRowIndex: 0, endRowIndex: 1 }, cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: { red: 0.88, green: 0.94, blue: 0.9 } } }, fields: 'userEnteredFormat(textFormat,backgroundColor)' } },
    { autoResizeDimensions: { dimensions: { sheetId, dimension: 'COLUMNS', startIndex: 1, endIndex: layout.header.length } } },
    // Only the school's account may edit the header row and the learner columns.
    { addProtectedRange: { protectedRange: { range: { sheetId, startRowIndex: 0, endRowIndex: 1 }, description: 'Header — do not edit', warningOnly: false } } },
    { repeatCell: { range: { sheetId, startRowIndex: 1, endRowIndex: 2 }, cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: { red: 1, green: 0.95, blue: 0.8 } } }, fields: 'userEnteredFormat(textFormat,backgroundColor)' } },
    { addProtectedRange: { protectedRange: { range: { sheetId, startRowIndex: 1, endRowIndex: 2, startColumnIndex: 0, endColumnIndex: 3 }, description: 'Out of label — do not edit', warningOnly: false } } },
    { addProtectedRange: { protectedRange: { range: { sheetId, startRowIndex: FIRST_LEARNER_ROW, endRowIndex: lastRow, startColumnIndex: 0, endColumnIndex: 3 }, description: 'Learner list — managed by the school', warningOnly: false } } },
    // % and Level: worked out by the sheet, so locked (whole columns, so learners added later are covered too).
    { addProtectedRange: { protectedRange: { range: { sheetId, startColumnIndex: layout.scoreEnd, endColumnIndex: layout.scoreEnd + 2 }, description: '% and Level — worked out automatically', warningOnly: false } } },
    { repeatCell: { range: { sheetId, startRowIndex: FIRST_LEARNER_ROW, startColumnIndex: layout.scoreEnd, endColumnIndex: layout.scoreEnd + 2 }, cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: { red: 0.95, green: 0.95, blue: 0.95 } } }, fields: 'userEnteredFormat(textFormat,backgroundColor)' } },
    // "Out of" marks: a number from 1 to 1000.
    { setDataValidation: { range: { sheetId, startRowIndex: 1, endRowIndex: 2, startColumnIndex: layout.scoreStart, endColumnIndex: layout.scoreEnd },
      rule: { condition: { type: 'NUMBER_BETWEEN', values: [{ userEnteredValue: '1' }, { userEnteredValue: '1000' }] }, inputMessage: 'What this column is marked out of, e.g. 20 or 50', strict: true, showCustomUi: true } } },
    ...scoreValidation(sheetId, layout.scoreStart, components, FIRST_LEARNER_ROW, lastRow),
  ];
}

/**
 * One workbook for one teacher: a tab per learning area and class, shared with one email.
 * @param {{ title, tabs: Array<{ title, components, learners, levels }>, shareWith?, message? }} p
 * @returns {{ spreadsheetId, url, tabs: Array<{ title, sheetId }> }}  tabs in the same order as given
 */
async function createWorkbook(refreshToken, { title, tabs, shareWith, message }) {
  const auth = authFor(refreshToken);
  const sheets = sheetsApi({ version: 'v4', auth });
  const drive = driveApi({ version: 'v3', auth });
  const titles = tabTitles(tabs.map(t => t.title));

  const { data: created } = await sheets.spreadsheets.create({
    requestBody: {
      properties: { title },
      sheets: titles.map((t, i) => ({ properties: { title: t, index: i, gridProperties: { frozenRowCount: 2, frozenColumnCount: 3 } } })),
    },
  });
  const spreadsheetId = created.spreadsheetId;
  const idOf = new Map(created.sheets.map(x => [x.properties.title, x.properties.sheetId]));
  await fillTabs(sheets, spreadsheetId, tabs, titles, idOf);
  if (shareWith) {
    await drive.permissions.create({
      fileId: spreadsheetId, sendNotificationEmail: true, emailMessage: message,
      requestBody: { type: 'user', role: 'writer', emailAddress: shareWith },
    });
  }
  return { spreadsheetId, url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`, tabs: titles.map(t => ({ title: t, sheetId: idOf.get(t) })) };
}

/**
 * Adds tabs to a workbook already shared with the teacher (e.g. a class held back until its learners
 * were paid for). The teacher already has access, so no new email is sent.
 */
async function addTabsToWorkbook(refreshToken, spreadsheetId, { tabs }) {
  const sheets = sheetsApi({ version: 'v4', auth: authFor(refreshToken) });
  const { data: meta } = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets(properties(sheetId,title))' });
  const existing = meta.sheets.map(x => x.properties.title);
  const titles = tabTitles([...existing, ...tabs.map(t => t.title)]).slice(existing.length);
  const { data } = await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: titles.map(t => ({
    addSheet: { properties: { title: t, gridProperties: { frozenRowCount: 2, frozenColumnCount: 3 } } } })) } });
  const idOf = new Map(data.replies.map(r => [r.addSheet.properties.title, r.addSheet.properties.sheetId]));
  await fillTabs(sheets, spreadsheetId, tabs, titles, idOf);
  return { spreadsheetId, url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`, tabs: titles.map(t => ({ title: t, sheetId: idOf.get(t) })) };
}

// Writes each tab's grid, formulas, formatting, locks and checks.
async function fillTabs(sheets, spreadsheetId, tabs, titles, idOf) {
  const layouts = tabs.map(t => buildSheetLayout(t));

  // Names and marks are written as plain text (RAW), so nothing a user typed can become a formula.
  await sheets.spreadsheets.values.batchUpdate({ spreadsheetId, requestBody: { valueInputOption: 'RAW',
    data: layouts.map((l, i) => ({ range: onTab(titles[i], 'A1'), values: [...l.top, ...l.rows] })) } });
  // Formulas are our own text (never learner names), so they are written separately as formulas.
  const formulas = tabs.map((t, i) => (layouts[i].rows.length
    ? { tab: titles[i], f: rowFormulas(t.components, t.levels, FIRST_LEARNER_ROW + 1, layouts[i].rows.length + FIRST_LEARNER_ROW) } : null)).filter(Boolean);
  if (formulas.length) {
    await sheets.spreadsheets.values.batchUpdate({ spreadsheetId, requestBody: { valueInputOption: 'USER_ENTERED',
      data: formulas.map(({ tab, f }) => ({ range: onTab(tab, f.range), values: f.values })) } });
  }
  const requests = tabs.flatMap((t, i) => tabRequests(idOf.get(titles[i]), layouts[i], t.components, layouts[i].rows.length + FIRST_LEARNER_ROW));
  await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });
}

// Adds learners (e.g. paid for after the workbook was sent) to the bottom of a tab,
// with the same locked name columns, formulas and score checks.
async function addLearnersToSheet(refreshToken, spreadsheetId, { tab = SCORES_TAB, components, learners, levels }) {
  const sheets = sheetsApi({ version: 'v4', auth: authFor(refreshToken) });
  const { data: meta } = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets(properties(sheetId,title))' });
  const sheetId = meta.sheets.find(x => x.properties.title === tab).properties.sheetId;
  const { data } = await sheets.spreadsheets.values.append({
    spreadsheetId, range: onTab(tab, 'A1'), valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS',
    requestBody: { values: learnerRows(components, learners) },
  });
  const m = /![A-Z]+(\d+):[A-Z]+(\d+)$/.exec(data.updates.updatedRange);
  const startRow = Number(m[1]) - 1;
  const endRow = Number(m[2]);
  const start = FIXED_COLS.length;
  const f = rowFormulas(components, levels, startRow + 1, endRow);
  await sheets.spreadsheets.values.update({ spreadsheetId, range: onTab(tab, f.range), valueInputOption: 'USER_ENTERED', requestBody: { values: f.values } });
  await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: [
    { addProtectedRange: { protectedRange: { range: { sheetId, startRowIndex: startRow, endRowIndex: endRow, startColumnIndex: 0, endColumnIndex: 3 }, description: 'Learner list — managed by the school', warningOnly: false } } },
    ...scoreValidation(sheetId, start, components, startRow, endRow),
  ] } });
  return { added: learners.length };
}

async function readAssessmentSheet(refreshToken, spreadsheetId, tab = SCORES_TAB) {
  const sheets = sheetsApi({ version: 'v4', auth: authFor(refreshToken) });
  const { data } = await sheets.spreadsheets.values.get({ spreadsheetId, range: onTab(tab, 'A1:ZZ'), valueRenderOption: 'UNFORMATTED_VALUE' });
  return data.values || [];
}

module.exports = { authUrl, exchangeCode, buildSheetLayout, parseSheetValues, rowFormulas, tabTitles, onTab, createWorkbook, addTabsToWorkbook, addLearnersToSheet, readAssessmentSheet, componentHeader, colLetter, OUT_OF_LABEL };
