// Maps rows from a school's own spreadsheet (any reasonable headings) to learner fields.
// Used by the web app, and by the tests under Node.
(function (root) {
  const SYNONYMS = {
    adm_no: ['adm', 'admno', 'admnumber', 'admission', 'admissionno', 'admissionnumber', 'regno'],
    assessment_no: ['assessmentno', 'assessmentnumber', 'assessment', 'knecno', 'knec'],
    first_name: ['firstname', 'first', 'givenname', 'fname'],
    last_name: ['lastname', 'surname', 'last', 'othernames', 'lname', 'secondname'],
    full_name: ['name', 'fullname', 'learnername', 'learner', 'studentname', 'pupilname', 'names'],
    gender: ['gender', 'sex'],
    parent_name: ['parentname', 'parent', 'guardian', 'guardianname', 'parentguardian', 'parentsname'],
    parent_phone: ['parentphone', 'phone', 'phoneno', 'phonenumber', 'parentphoneno', 'guardianphone', 'contact', 'mobile', 'telephone', 'tel', 'parentcontact'],
  };
  const norm = h => String(h || '').toLowerCase().replace(/[^a-z0-9]/g, '');

  function fieldFor(header) {
    const n = norm(header);
    if (!n) return null;
    for (const [field, names] of Object.entries(SYNONYMS)) if (names.includes(n)) return field;
    return null;
  }

  /**
   * @param {Array<object>} rows  objects keyed by the spreadsheet's own headings
   * @returns {{ learners: Array<object>, unknown: string[] }}
   */
  function mapLearnerRows(rows) {
    const headers = [...new Set(rows.flatMap(r => Object.keys(r)))];
    const map = Object.fromEntries(headers.map(h => [h, fieldFor(h)]));
    const unknown = headers.filter(h => !map[h] && !/^__EMPTY/.test(h));
    const learners = rows.map(r => {
      const l = {};
      for (const [h, field] of Object.entries(map)) {
        if (!field || r[h] == null || String(r[h]).trim() === '') continue;
        l[field] = String(r[h]).trim();
      }
      // A single "Name" column: first word is the first name, the rest the last name.
      if (l.full_name && !l.first_name && !l.last_name) {
        const parts = l.full_name.split(/\s+/);
        l.first_name = parts.shift();
        l.last_name = parts.join(' ');
      }
      delete l.full_name;
      return l;
    }).filter(l => l.first_name || l.last_name || l.adm_no);
    return { learners, unknown };
  }

  const api = { mapLearnerRows, fieldFor };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LearnerColumns = api;
})(this);
