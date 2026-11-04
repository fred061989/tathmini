const test = require('node:test');
const assert = require('node:assert/strict');
const { mapLearnerRows, fieldFor } = require('../public/learner-columns');

test('recognises common headings', () => {
  assert.deepEqual(['Adm No', 'ADMISSION NUMBER', 'Surname', 'Sex', "Parent's Name", 'Parent Phone', 'Mobile', 'Assessment No.', 'Favourite colour']
    .map(fieldFor), ['adm_no', 'adm_no', 'last_name', 'gender', 'parent_name', 'parent_phone', 'parent_phone', 'assessment_no', null]);
});

test('maps rows, splits a single Name column, skips empty rows, lists unknown columns', () => {
  const { learners, unknown } = mapLearnerRows([
    { 'Adm No': 1021, Name: 'Amani Wanjiku Otieno', Sex: 'F', 'Parent Phone': '0712345678', House: 'Simba' },
    { 'Adm No': 1022, Name: 'Baraka', Sex: 'M' },
    { 'Adm No': '', Name: '', Sex: '' },
  ]);
  assert.deepEqual(learners, [
    { adm_no: '1021', gender: 'F', parent_phone: '0712345678', first_name: 'Amani', last_name: 'Wanjiku Otieno' },
    { adm_no: '1022', gender: 'M', first_name: 'Baraka', last_name: '' },
  ]);
  assert.deepEqual(unknown, ['House']);
});

test('separate first and last name columns win over a Name column', () => {
  const { learners } = mapLearnerRows([{ 'First Name': 'Chebet', Surname: 'Kiprop', Name: 'ignored' }]);
  assert.deepEqual(learners, [{ first_name: 'Chebet', last_name: 'Kiprop' }]);
});
