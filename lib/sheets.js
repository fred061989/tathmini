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

function componentHeader(c) {
  return `${c.label} (/${Number(c.max_score)})`;
}

// Pure: the grid a teacher fills in. Column A (learner id) is hidden.
function buildSheetLayout({ components, learners }) {
  const header = [...FIXED_COLS, ...components.map(componentHeader), ...TRAILING_COLS];
  const rows = learners.map(l => [l.id, l.adm_no || '', `${l.first_name} ${l.last_name}`.trim(), ...components.map(() => ''), '', '']);
  return { header, rows, scoreStart: FIXED_COLS.length, scoreEnd: FIXED_COLS.length + components.length };
}

// Pure: reads the teacher's grid back into score rows.
function parseSheetValues(values, components, learners) {
  const issues = [];
  const [header = [], ...rows] = values || [];
  const start = FIXED_COLS.length;
  components.map(componentHeader).forEach((h, i) => {
    if (String(header[start + i] || '').trim() !== h) {
      issues.push(`Column ${start + i + 1} should be "${h}" but is "${header[start + i] || ''}". Do not edit or reorder header columns.`);
    }
  });
  if (issues.length) return { scores: [], issues };

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
  if (missing) issues.push(`${missing} learner row(s) missing from the sheet; they will be treated as not assessed.`);
  return { scores, issues };
}

async function createAssessmentSheet(refreshToken, { title, components, learners, shareWith, message }) {
  const auth = authFor(refreshToken);
  const sheets = sheetsApi({ version: 'v4', auth });
  const drive = driveApi({ version: 'v3', auth });
  const layout = buildSheetLayout({ components, learners });

  const { data: created } = await sheets.spreadsheets.create({
    requestBody: {
      properties: { title },
      sheets: [{ properties: { title: SCORES_TAB, gridProperties: { frozenRowCount: 1, frozenColumnCount: 3 } } }],
    },
  });
  const spreadsheetId = created.spreadsheetId;
  const sheetId = created.sheets[0].properties.sheetId;
  await sheets.spreadsheets.values.update({
    spreadsheetId, range: `${SCORES_TAB}!A1`, valueInputOption: 'RAW', requestBody: { values: [layout.header, ...layout.rows] },
  });

  const lastRow = layout.rows.length + 1;
  const requests = [
    { updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: 1 }, properties: { hiddenByUser: true }, fields: 'hiddenByUser' } },
    { repeatCell: { range: { sheetId, startRowIndex: 0, endRowIndex: 1 }, cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: { red: 0.88, green: 0.94, blue: 0.9 } } }, fields: 'userEnteredFormat(textFormat,backgroundColor)' } },
    { autoResizeDimensions: { dimensions: { sheetId, dimension: 'COLUMNS', startIndex: 1, endIndex: layout.header.length } } },
    // Only the school's account may edit the header row and the learner columns.
    { addProtectedRange: { protectedRange: { range: { sheetId, startRowIndex: 0, endRowIndex: 1 }, description: 'Header — do not edit', warningOnly: false } } },
    { addProtectedRange: { protectedRange: { range: { sheetId, startRowIndex: 1, endRowIndex: lastRow, startColumnIndex: 0, endColumnIndex: 3 }, description: 'Learner list — managed by the school', warningOnly: false } } },
    ...components.map((c, i) => ({
      setDataValidation: {
        range: { sheetId, startRowIndex: 1, endRowIndex: lastRow, startColumnIndex: layout.scoreStart + i, endColumnIndex: layout.scoreStart + i + 1 },
        rule: { condition: { type: 'NUMBER_BETWEEN', values: [{ userEnteredValue: '0' }, { userEnteredValue: String(c.max_score) }] },
          inputMessage: `Score out of ${c.max_score}`, strict: true, showCustomUi: true },
      },
    })),
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

async function readAssessmentSheet(refreshToken, spreadsheetId) {
  const sheets = sheetsApi({ version: 'v4', auth: authFor(refreshToken) });
  const { data } = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${SCORES_TAB}!A1:ZZ`, valueRenderOption: 'UNFORMATTED_VALUE' });
  return data.values || [];
}

module.exports = { authUrl, exchangeCode, buildSheetLayout, parseSheetValues, createAssessmentSheet, readAssessmentSheet, componentHeader };
