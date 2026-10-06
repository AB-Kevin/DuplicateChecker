'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const XLSX = require('xlsx');
const { readTable } = require('../src/main/spreadsheet');
const { openBooks } = require('../src/main/books');
const { importFile, applyDecisions, ImportError } = require('../src/main/processor');

const HEADERS = ['Member ID', 'PatientName', 'CPT Code', 'Service Date', 'Charge Amount'];

function setup(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dupcheck-'));
  const settings = {
    inboxDir: path.join(root, 'Inbox'),
    outputDir: path.join(root, 'Output'),
    fields: ['Member ID', 'PatientName', 'CPT Code', 'Service Date'],
    threshold: 3,
    retentionDays: 365,
    ...overrides,
  };
  fs.mkdirSync(settings.inboxDir, { recursive: true });
  const state = { queue: [], log: [] };
  const ctx = { settings, state, books: openBooks(settings.outputDir), saveState() {} };
  const drop = (name, rows, headers = HEADERS) => {
    const sheet = XLSX.utils.aoa_to_sheet([headers, ...rows]);
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, 'Sheet1');
    const file = path.join(settings.inboxDir, name);
    XLSX.writeFile(book, file);
    return file;
  };
  const read = (name) => readTable(path.join(settings.outputDir, name));
  return { root, settings, state, ctx, drop, read };
}

test('first import goes straight to the database; in-file duplicates are flagged', () => {
  const { ctx, state, drop, read, settings } = setup();
  const file = drop('week1.xlsx', [
    ['100', 'Ann Lee', '99213', '3/15/2026', '$50.00'],
    ['200', 'Bob Ray', '99214', '3/16/2026', '$75.00'],
    ['100', 'ann lee', '99213', '3/20/2026', '$50.00'], // 3 of 4 match row 2
  ]);

  const entry = importFile(file, ctx);
  assert.equal(entry.status, 'imported');
  assert.equal(entry.added, 2);
  assert.equal(entry.flagged, 1);
  assert.equal(fs.existsSync(file), false, 'file moved out of the inbox');
  assert.equal(fs.readdirSync(path.join(settings.outputDir, 'Processed')).length, 1);

  const db = read('Database.xlsx');
  assert.deepEqual(db.headers, [...HEADERS, 'Date Added', 'Source File', 'Source Row']);
  assert.equal(db.rows.length, 2);
  assert.equal(db.rows[0].values['Charge Amount'], '$50.00');
  assert.equal(db.rows[0].values['Source File'], 'week1.xlsx');

  assert.equal(state.queue.length, 1);
  const item = state.queue[0];
  assert.equal(item.rowNumber, 4);
  assert.equal(item.matches[0].kind, 'batch');
  assert.equal(item.matches[0].sourceRow, 2);
  assert.deepEqual(item.matches[0].fields, ['Member ID', 'PatientName', 'CPT Code']);
});

test('next week is checked against the database, and decisions land in the right file', () => {
  const { ctx, state, drop, read } = setup();
  importFile(drop('week1.xlsx', [
    ['100', 'Ann Lee', '99213', '3/15/2026', '$50.00'],
    ['200', 'Bob Ray', '99214', '3/16/2026', '$75.00'],
  ]), ctx);

  const entry = importFile(drop('week2.csv', [
    ['100', 'ANN LEE', '99213', '2026-03-15', '50'], // matches week1 row 2
    ['200', 'Bob Ray', '99999', '3/16/2026', '75'], // matches week1 row 3 on 3 of 4
    ['300', 'Cal Orr', '99213', '3/15/2026', '20'], // matches only 2 columns of row 2
  ]), ctx);
  assert.equal(entry.added, 1);
  assert.equal(entry.flagged, 2);
  assert.equal(state.queue[0].matches[0].kind, 'database');
  assert.equal(state.queue[0].matches[0].sourceFile, 'week1.xlsx');

  state.queue[0].decision = 'duplicate';
  state.queue[1].decision = 'unique';
  const result = applyDecisions(ctx);
  assert.deepEqual(result, { duplicates: 1, added: 1, expired: 0 });
  assert.equal(state.queue.length, 0);

  const dups = read('Duplicates.xlsx');
  assert.equal(dups.rows.length, 1);
  assert.equal(dups.rows[0].values.PatientName, 'ANN LEE');
  assert.equal(dups.rows[0].values['Matched On'], 'Member ID, PatientName, CPT Code, Service Date');
  assert.match(dups.rows[0].values['Duplicate Of'], /^Database entry from week1\.xlsx, row 2/);

  const db = read('Database.xlsx');
  assert.equal(db.rows.length, 4);
  assert.deepEqual(db.rows.map((r) => r.values['Member ID']), ['100', '200', '300', '200']);
});

test('undecided items stay in the queue and new files are checked against them', () => {
  const { ctx, state, drop } = setup();
  importFile(drop('a.xlsx', [['1', 'A', 'X', '1/1/2026'], ['1', 'A', 'X', '1/2/2026']]), ctx);
  assert.equal(state.queue.length, 1);
  importFile(drop('b.xlsx', [['1', 'A', 'X', '1/3/2026']]), ctx);
  assert.equal(state.queue.length, 2);
  const kinds = state.queue[1].matches.map((m) => m.kind).sort();
  assert.deepEqual(kinds, ['database', 'queue']);
  assert.deepEqual(applyDecisions(ctx), { duplicates: 0, added: 0, expired: 0 });
});

test('entries older than the retention period are dropped and no longer match', () => {
  const { ctx, state, drop, read } = setup({ retentionDays: 30 });
  importFile(drop('old.xlsx', [['100', 'Ann Lee', '99213', '1/5/2026', '$10.00']]), { ...ctx, now: new Date(2026, 0, 5) });
  const entry = importFile(drop('new.xlsx', [['100', 'Ann Lee', '99213', '1/5/2026', '$20.00']]), { ...ctx, now: new Date(2026, 2, 1) });
  assert.equal(entry.flagged, 0);
  assert.equal(entry.expired, 1);
  assert.equal(state.queue.length, 0);
  const db = read('Database.xlsx');
  assert.equal(db.rows.length, 1);
  assert.equal(db.rows[0].values['Source File'], 'new.xlsx');
});

test('a re-dropped identical file is skipped', () => {
  const { root, ctx, drop, read } = setup();
  const file = drop('w.xlsx', [['100', 'Ann Lee', '99213', '1/5/2026']]);
  const copy = path.join(root, 'copy.xlsx');
  fs.copyFileSync(file, copy);
  importFile(file, ctx);
  fs.copyFileSync(copy, file);
  const entry = importFile(file, ctx);
  assert.equal(entry.status, 'skipped');
  assert.equal(read('Database.xlsx').rows.length, 1);
});

test('files missing too many compare columns are left in the inbox', () => {
  const { ctx, drop } = setup();
  const file = drop('bad.xlsx', [['100', 'Ann']], ['Member ID', 'PatientName']);
  assert.throws(() => importFile(file, ctx), ImportError);
  assert.equal(fs.existsSync(file), true);
});

test('a file missing one compare column is still checked on the rest', () => {
  const { ctx, state, drop } = setup();
  importFile(drop('a.xlsx', [['100', 'Ann', '99213', '1/1/2026']]), ctx);
  const entry = importFile(drop('b.xlsx', [['100', 'Ann', '99213']], ['Member ID', 'PatientName', 'CPT Code']), ctx);
  assert.equal(entry.flagged, 1);
  assert.deepEqual(entry.missingFields, ['Service Date']);
  assert.equal(state.queue.length, 1);
});

test('a column named like a bookkeeping column is renamed, not overwritten', () => {
  const { ctx, drop, read } = setup();
  importFile(drop('a.xlsx', [['100', 'Ann', '99213', '1/1/2026', 'theirs']], [...HEADERS.slice(0, 4), 'Date Added']), ctx);
  const db = read('Database.xlsx');
  assert.ok(db.headers.includes('Date Added (original)'));
  assert.equal(db.rows[0].values['Date Added (original)'], 'theirs');
  assert.match(db.rows[0].values['Date Added'], /^\d{4}-\d{2}-\d{2}$/);
});
