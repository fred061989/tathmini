// Starter national curriculum (rationalised CBC learning areas per grade).
//
// The platform owner maintains the national curriculum for every school. This file is
// only the starting point loaded by "Load starter curriculum": learning areas per grade,
// plus strands (and some sub-strands) for Junior School. CHECK THE STRANDS AGAINST THE
// CURRENT KICD CURRICULUM DESIGNS and complete the rest with a CSV import.

const PP = [-1, 0];
const LOWER = [1, 2, 3];
const UPPER = [4, 5, 6];
const JSS = [7, 8, 9];

const LEARNING_AREAS = [
  { name: 'Language Activities', code: 'LAN', grades: PP },
  { name: 'Mathematical Activities', code: 'MAA', grades: PP },
  { name: 'Religious Education Activities', code: 'REA', grades: PP },
  { name: 'Environmental Activities', code: 'ENV', grades: [...PP, ...LOWER] },
  { name: 'Creative Activities', code: 'CRA', grades: [...PP, ...LOWER] },
  { name: 'Indigenous Language', code: 'IND', grades: LOWER },
  { name: 'English', code: 'ENG', grades: [...LOWER, ...UPPER, ...JSS] },
  { name: 'Kiswahili', code: 'KIS', grades: [...LOWER, ...UPPER, ...JSS] },
  { name: 'Kenyan Sign Language', code: 'KSL', grades: [...LOWER, ...UPPER, ...JSS] },
  { name: 'Mathematics', code: 'MAT', grades: [...LOWER, ...UPPER, ...JSS] },
  { name: 'Christian Religious Education', code: 'CRE', grades: [...LOWER, ...UPPER, ...JSS] },
  { name: 'Islamic Religious Education', code: 'IRE', grades: [...LOWER, ...UPPER, ...JSS] },
  { name: 'Hindu Religious Education', code: 'HRE', grades: [...LOWER, ...UPPER, ...JSS] },
  { name: 'Science and Technology', code: 'SCT', grades: UPPER },
  { name: 'Creative Arts', code: 'CA', grades: UPPER },
  { name: 'Agriculture and Nutrition', code: 'AGN', grades: [...UPPER, ...JSS] },
  { name: 'Social Studies', code: 'SST', grades: [...UPPER, ...JSS] },
  { name: 'Integrated Science', code: 'ISC', grades: JSS },
  { name: 'Pre-Technical Studies', code: 'PTS', grades: JSS },
  { name: 'Creative Arts and Sports', code: 'CAS', grades: JSS },
];

const MATHS_JSS = ['Numbers', 'Algebra', 'Measurements', 'Geometry', 'Data Handling and Probability'];
const ENGLISH = ['Listening and Speaking', 'Reading', 'Grammar in Use', 'Writing'];
const KISWAHILI = ['Kusikiliza na Kuzungumza', 'Kusoma', 'Sarufi', 'Kuandika'];

// { 'Learning area': { grade: [strand, ...] or [[strand, [sub-strands]], ...] } }
const STRANDS = {
  Mathematics: {
    7: [
      ['Numbers', ['Whole Numbers', 'Factors', 'Fractions', 'Decimals', 'Squares and Square Roots']],
      ['Algebra', ['Algebraic Expressions', 'Linear Equations', 'Linear Inequalities']],
      ['Measurements', ['Pythagorean Relationship', 'Length', 'Area', 'Volume and Capacity', 'Time, Distance and Speed', 'Temperature', 'Money']],
      ['Geometry', ['Angles', 'Geometrical Constructions']],
      ['Data Handling and Probability', ['Data Presentation and Interpretation']],
    ],
    8: MATHS_JSS,
    9: MATHS_JSS,
  },
  English: { 7: ENGLISH, 8: ENGLISH, 9: ENGLISH },
  Kiswahili: { 7: KISWAHILI, 8: KISWAHILI, 9: KISWAHILI },
  'Integrated Science': {
    7: ['Scientific Investigation', 'Mixtures, Elements and Compounds', 'Living Things and their Environment', 'Force and Energy'],
  },
  'Pre-Technical Studies': {
    7: ['Foundations of Pre-Technical Studies', 'Communication in Pre-Technical Studies', 'Materials for Production', 'Tools and Production', 'Entrepreneurship'],
  },
};

// Flattened to the same row format as a CSV import.
function starterRows() {
  const rows = [];
  for (const a of LEARNING_AREAS) {
    for (const grade of a.grades) {
      const strands = STRANDS[a.name]?.[grade];
      if (!strands) {
        rows.push({ grade, learning_area: a.name, code: a.code, strand: '', sub_strand: '' });
        continue;
      }
      for (const s of strands) {
        const [strand, subs] = Array.isArray(s) ? s : [s, []];
        if (!subs.length) rows.push({ grade, learning_area: a.name, code: a.code, strand, sub_strand: '' });
        for (const sub of subs) rows.push({ grade, learning_area: a.name, code: a.code, strand, sub_strand: sub });
      }
    }
  }
  return rows;
}

module.exports = { LEARNING_AREAS, STRANDS, starterRows };
