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
const TRAILING_COLS = ['Absent (Y)', 'Comment'];
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
  const absentCol = start + components.length;
  const scores = [];
  const seen = new Set();
  for (const row of rows) {
    const learnerId = String(row[0] || '').trim();
    if (!learnerId) continue;
    if (!known.has(learnerId)) { issues.push(`Row for "${row[2] || learnerId}" is not a learner in this class; skipped.`); continue; }
    seen.add(learnerId);
    const absent = /^(y|yes|a|abs|absent|true|1)$/i.test(String(row[absentCol] ?? '').trim());
    const comment = String(row[absentCol + 1] ?? '').trim() || null;
    components.forEach((c, i) => {
      const raw = row[start + i];
      scores.push({
        learner_id: learnerId, component_id: c.id,
        raw_score: raw == null || String(raw).trim() === '' ? null : String(raw).trim(),
        absent, comment: i === 0 ? comment : null,
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
        rule: { condition: { type: 'CUSTOM_FORMULA', values: [{ userEnteredValue: `=AND(ISNUMBER(${L}${startRow + 1}),${L}${startRow + 1}>=0,${L}${startRow + 1}<=${L}$2)` }] },
          inputMessage: `Score from 0 to the "Out of" mark in row 2`, strict: true, showCustomUi: true },
      },
    };
  });
}

async function createAssessmentSheet(refreshToken, { title, components, learners, shareWith, message }) {
  const auth = authFor(refreshToken);
  const sheets = sheetsApi({ version: 'v4', auth });
  const drive = driveApi({ version: 'v3', auth });
  const layout = buildSheetLayout({ components, learners });

  const { data: created } = await sheets.spreadsheets.create({
    requestBody: {
      properties: { title },
      sheets: [{ properties: { title: SCORES_TAB, gridProperties: { frozenRowCount: 2, frozenColumnCount: 3 } } }],
    },
  });
  const spreadsheetId = created.spreadsheetId;
  const sheetId = created.sheets[0].properties.sheetId;
  await sheets.spreadsheets.values.update({
    spreadsheetId, range: `${SCORES_TAB}!A1`, valueInputOption: 'RAW', requestBody: { values: [...layout.top, ...layout.rows] },
  });

  const lastRow = layout.rows.length + FIRST_LEARNER_ROW;
  const requests = [
    { updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: 1 }, properties: { hiddenByUser: true }, fields: 'hiddenByUser' } },
    { repeatCell: { range: { sheetId, startRowIndex: 0, endRowIndex: 1 }, cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: { red: 0.88, green: 0.94, blue: 0.9 } } }, fields: 'userEnteredFormat(textFormat,backgroundColor)' } },
    { autoResizeDimensions: { dimensions: { sheetId, dimension: 'COLUMNS', startIndex: 1, endIndex: layout.header.length } } },
    // Only the school's account may edit the header row and the learner columns.
    { addProtectedRange: { protectedRange: { range: { sheetId, startRowIndex: 0, endRowIndex: 1 }, description: 'Header — do not edit', warningOnly: false } } },
    { repeatCell: { range: { sheetId, startRowIndex: 1, endRowIndex: 2 }, cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: { red: 1, green: 0.95, blue: 0.8 } } }, fields: 'userEnteredFormat(textFormat,backgroundColor)' } },
    { addProtectedRange: { protectedRange: { range: { sheetId, startRowIndex: 1, endRowIndex: 2, startColumnIndex: 0, endColumnIndex: 3 }, description: 'Out of label — do not edit', warningOnly: false } } },
    { addProtectedRange: { protectedRange: { range: { sheetId, startRowIndex: FIRST_LEARNER_ROW, endRowIndex: lastRow, startColumnIndex: 0, endColumnIndex: 3 }, description: 'Learner list — managed by the school', warningOnly: false } } },
    // "Out of" marks: a number from 1 to 1000.
    { setDataValidation: { range: { sheetId, startRowIndex: 1, endRowIndex: 2, startColumnIndex: layout.scoreStart, endColumnIndex: layout.scoreEnd },
      rule: { condition: { type: 'NUMBER_BETWEEN', values: [{ userEnteredValue: '1' }, { userEnteredValue: '1000' }] }, inputMessage: 'What this column is marked out of, e.g. 20 or 50', strict: true, showCustomUi: true } } },
    ...scoreValidation(sheetId, layout.scoreStart, components, FIRST_LEARNER_ROW, lastRow),
  ];
  await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });
  if (shareWith) {
    await drive.permissions.create({
      fileId: spreadsheetId, sendNotificationEmail: true, emailMessage: message,
      requestBody: { type: 'user', role: 'writer', emailAddress: shareWith },
    });
  }
  return { spreadsheetId, url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit` };
}

// Adds learners (e.g. paid for after the sheet was sent) to the bottom of an existing sheet,
// with the same locked name columns and score checks.
async function addLearnersToSheet(refreshToken, spreadsheetId, { components, learners }) {
  const sheets = sheetsApi({ version: 'v4', auth: authFor(refreshToken) });
  const { data: meta } = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets(properties(sheetId,title))' });
  const sheetId = meta.sheets.find(x => x.properties.title === SCORES_TAB).properties.sheetId;
  const { data } = await sheets.spreadsheets.values.append({
    spreadsheetId, range: `${SCORES_TAB}!A1`, valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS',
    requestBody: { values: learnerRows(components, learners) },
  });
  const m = /![A-Z]+(\d+):[A-Z]+(\d+)$/.exec(data.updates.updatedRange);
  const startRow = Number(m[1]) - 1;
  const endRow = Number(m[2]);
  const start = FIXED_COLS.length;
  await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: [
    { addProtectedRange: { protectedRange: { range: { sheetId, startRowIndex: startRow, endRowIndex: endRow, startColumnIndex: 0, endColumnIndex: 3 }, description: 'Learner list — managed by the school', warningOnly: false } } },
    ...scoreValidation(sheetId, start, components, startRow, endRow),
  ] } });
  return { added: learners.length };
}

async function readAssessmentSheet(refreshToken, spreadsheetId) {
  const sheets = sheetsApi({ version: 'v4', auth: authFor(refreshToken) });
  const { data } = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${SCORES_TAB}!A1:ZZ`, valueRenderOption: 'UNFORMATTED_VALUE' });
  return data.values || [];
}

module.exports = { authUrl, exchangeCode, buildSheetLayout, parseSheetValues, createAssessmentSheet, addLearnersToSheet, readAssessmentSheet, componentHeader, colLetter, OUT_OF_LABEL };
