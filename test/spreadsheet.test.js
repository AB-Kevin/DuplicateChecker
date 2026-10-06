'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const XLSX = require('xlsx');
const { readTable } = require('../src/main/spreadsheet');

function writeSheet(sheet) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dupcheck-sheet-')), 'test.xlsx');
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, 'Sheet1');
  XLSX.writeFile(book, file);
  return file;
}

test('empty columns and rows past the data are ignored', () => {
  const sheet = XLSX.utils.aoa_to_sheet([
    ['Member ID', 'PatientName', 'Charge Amount'],
    ['100', 'Ann Lee', '$50.00'],
    ['200', 'Bob Ray', '$75.00'],
  ]);
  // Blank cells out to column CV, as when formatting is applied to whole columns.
  for (let r = 0; r < 5; r++) {
    for (let c = 3; c <= XLSX.utils.decode_col('CV'); c++) {
      sheet[XLSX.utils.encode_cell({ r, c })] = { t: 's', v: '' };
    }
  }
  sheet['!ref'] = 'A1:CV500';

  const table = readTable(writeSheet(sheet));
  assert.deepEqual(table.headers, ['Member ID', 'PatientName', 'Charge Amount']);
  assert.deepEqual(table.rows.map((r) => r.rowNumber), [2, 3]);
  assert.deepEqual(table.rows[1].values, { 'Member ID': '200', PatientName: 'Bob Ray', 'Charge Amount': '$75.00' });
});

test('an unnamed column that holds data is kept, named by its letter', () => {
  const table = readTable(writeSheet(XLSX.utils.aoa_to_sheet([
    ['Name', '', 'Amount', '', ''],
    ['Ann', 'note', '5', '', ''],
    ['Bob', '', '6', '', ''],
  ])));
  assert.deepEqual(table.headers, ['Name', 'Column B', 'Amount']);
  assert.equal(table.rows[0].values['Column B'], 'note');
});

test('a table that starts below and right of A1 keeps its real row numbers and letters', () => {
  const sheet = XLSX.utils.aoa_to_sheet([]);
  XLSX.utils.sheet_add_aoa(sheet, [['Name', ''], ['Ann', 'x']], { origin: 'C4' });
  const table = readTable(writeSheet(sheet));
  assert.deepEqual(table.headers, ['Name', 'Column D']);
  assert.equal(table.rows[0].rowNumber, 5);
});
