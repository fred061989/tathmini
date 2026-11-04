// Kenyan phone numbers in +2547XXXXXXXX / +2541XXXXXXXX form, or null if invalid.
function normalizeKenyanPhone(phone) {
  let p = String(phone || '').replace(/[\s\-()]/g, '').replace(/^\+/, '');
  if (!p) return null;
  if (p.startsWith('0')) p = '254' + p.slice(1);
  if (/^[17]\d{8}$/.test(p)) p = '254' + p;
  return /^254[17]\d{8}$/.test(p) ? '+' + p : null;
}

module.exports = { normalizeKenyanPhone };
