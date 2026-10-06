'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const XLSX = require('xlsx');
const { readJson, writeJson } = require('../src/main/jsonfile');
const { openBooks, FileLockedError } = require('../src/main/books');
const { readTable } = require('../src/main/spreadsheet');
const { importFile } = require('../src/main/processor');
const {
  ACTIVE_MS, peopleDir, personPath, readPeople, activeHosts, firstSentDecisions,
  saveSentDecisions, settleDecisions, annotateQueue, Team,
} = require('../src/main/team');

const NOW = Date.parse('2026-10-06T12:00:00Z');
const ago = (ms) => new Date(NOW - ms).toISOString();
const person = (id, fields = {}) => ({ id, name: id, open: true, seen: ago(1000), role: 'reviewer', decisions: {}, ...fields });
const queue = (...ids) => ids.map((id) => ({ id, fileName: 'w.xlsx', rowNumber: 2 }));

test('the longest-serving active host acts as host', () => {
  const people = [
    person('jane', { role: 'host', hostSince: '2026-10-05T00:00:00Z' }),
    person('kevin', { role: 'host', hostSince: '2026-10-01T00:00:00Z' }),
    person('gone', { role: 'host', hostSince: '2026-09-01T00:00:00Z', open: false }),
    person('stale', { role: 'host', hostSince: '2026-09-01T00:00:00Z', seen: ago(ACTIVE_MS + 1) }),
    person('mark'),
  ];
  assert.deepEqual(activeHosts(people, NOW).map((p) => p.id), ['kevin', 'jane']);
});

test('for each entry, the first decision sent wins; drafts and finished entries are ignored', () => {
  const people = [
    person('kevin', { decisions: { a: { decision: 'unique', sent: '2026-10-06T10:05:00Z' }, b: { decision: 'duplicate', sent: null } } }),
    person('jane', { decisions: { a: { decision: 'duplicate', sent: '2026-10-06T10:01:00Z' }, gone: { decision: 'unique', sent: '2026-10-06T09:00:00Z' } } }),
  ];
  const first = firstSentDecisions(people, queue('a', 'b'));
  assert.deepEqual([...first.keys()], ['a']);
  assert.equal(first.get('a').personId, 'jane');
  assert.equal(first.get('a').decision, 'duplicate');
});

test('settling tells a person which decisions were saved and which someone else beat them to', () => {
  const me = person('kevin', {
    viewing: 'a',
    decisions: {
      a: { decision: 'unique', sent: '2026-10-06T10:05:00Z' }, // Jane decided differently first
      b: { decision: 'unique', sent: '2026-10-06T10:05:00Z' }, // saved as Kevin decided
      c: { decision: 'duplicate', sent: null }, // entry cleared away
      d: { decision: 'duplicate', sent: null }, // still waiting
    },
  });
  const state = {
    queue: queue('d'),
    resolved: [
      { id: 'a', decision: 'duplicate', personId: 'jane', name: 'Jane' },
      { id: 'b', decision: 'unique', personId: 'kevin', name: 'kevin' },
    ],
  };
  const { changed, saved, overruled } = settleDecisions(me, state);
  assert.equal(changed, true);
  assert.deepEqual(saved.map((r) => r.id), ['b']);
  assert.deepEqual(overruled.map((r) => r.id), ['a']);
  assert.deepEqual(Object.keys(me.decisions), ['d']);
  assert.equal(me.viewing, null);
  assert.equal(settleDecisions(me, state).changed, false);
});

test('each entry shows this person\'s decision, others\' decisions, who sent first and who has it open', () => {
  const me = person('kevin', { decisions: { a: { decision: 'unique', sent: null } } });
  const jane = person('jane', { name: 'Jane', viewing: 'b', decisions: { a: { decision: 'duplicate', sent: '2026-10-06T10:00:00Z' } } });
  const mark = person('mark', { name: 'Mark', viewing: 'b', seen: ago(ACTIVE_MS + 1), decisions: { b: { decision: 'unique', sent: null } } });
  const [a, b] = annotateQueue(queue('a', 'b'), me, [me, jane, mark], NOW);
  assert.equal(a.decision, 'unique');
  assert.equal(a.sent, false);
  assert.equal(a.lockedBy, 'Jane');
  assert.deepEqual(a.others, [{ name: 'Jane', decision: 'duplicate', sent: true }]);
  assert.equal(b.decision, null);
  assert.equal(b.lockedBy, null);
  assert.deepEqual(b.viewers, ['Jane'], 'Mark has left, so he is not shown as viewing');
  assert.deepEqual(b.others, [{ name: 'Mark', decision: 'unique', sent: false }]);
});

test('people files are read, and OneDrive conflict copies are ignored', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dupcheck-team-'));
  const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
  writeJson(personPath(dataDir, id), person(id));
  writeJson(path.join(peopleDir(dataDir), `${id}-KEVIN-PC.json`), person(id, { name: 'conflict copy' }));
  fs.writeFileSync(path.join(peopleDir(dataDir), 'notes.txt'), 'x');
  const people = readPeople(dataDir);
  assert.equal(people.length, 1);
  assert.equal(people[0].name, id);
});

function hostWithQueue() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dupcheck-host-'));
  const settings = {
    dataDir: path.join(root, 'Data'),
    requiredFields: [],
    fields: ['Member ID', 'PatientName', 'CPT Code'],
    threshold: 3,
    retentionDays: 365,
  };
  const inbox = path.join(root, 'Inbox');
  fs.mkdirSync(inbox, { recursive: true });
  const state = { queue: [], log: [], resolved: [] };
  const ctx = { settings, state, books: openBooks(settings.dataDir), saveState() {} };
  const file = path.join(inbox, 'w.xlsx');
  const sheet = XLSX.utils.aoa_to_sheet([
    ['Member ID', 'PatientName', 'CPT Code', 'Check #'],
    ['1', 'Ann', '99213', '100'],
    ['1', 'Ann', '99213', '101'], // flagged against row 2
    ['2', 'Bob', '99214', '102'],
    ['2', 'Bob', '99214', '103'], // flagged against row 4
  ]);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, 'Sheet1');
  XLSX.writeFile(book, file);
  importFile(file, ctx);
  return { ctx, state, settings };
}

test('the host saves everyone\'s sent decisions, first one winning, and records who decided', () => {
  const { ctx, state, settings } = hostWithQueue();
  const [annRow, bobRow] = state.queue;
  const kevin = person('kevin', { name: 'Kevin', decisions: {
    [annRow.id]: { decision: 'unique', sent: '2026-10-06T10:05:00Z' },
    [bobRow.id]: { decision: 'unique', sent: '2026-10-06T10:05:00Z' },
  } });
  const jane = person('jane', { name: 'Jane', decisions: { [annRow.id]: { decision: 'duplicate', sent: '2026-10-06T10:01:00Z' } } });

  const result = saveSentDecisions(ctx, [kevin, jane], new Date(NOW));
  assert.equal(result.duplicates, 1);
  assert.equal(result.added, 1);
  assert.deepEqual(result.people.sort(), ['jane', 'kevin']);
  assert.equal(state.queue.length, 0);
  assert.equal(state.applyError, null);
  assert.ok(state.queue.every((item) => !('decision' in item)));

  const dups = readTable(path.join(settings.dataDir, 'Duplicates.xlsx'));
  assert.deepEqual(dups.rows.map((r) => r.values['Check #']), ['101']);
  const byId = new Map(state.resolved.map((r) => [r.id, r]));
  assert.equal(byId.get(annRow.id).name, 'Jane');
  assert.equal(byId.get(bobRow.id).personId, 'kevin');

  const { saved, overruled } = settleDecisions(kevin, state);
  assert.deepEqual(saved.map((r) => r.id), [bobRow.id]);
  assert.deepEqual(overruled.map((r) => r.name), ['Jane']);
  assert.equal(saveSentDecisions(ctx, [kevin, jane]), null, 'nothing left to save');
});

test('if a spreadsheet is open, nothing is saved and everyone is told why', () => {
  const { ctx, state, settings } = hostWithQueue();
  const kevin = person('kevin', { decisions: { [state.queue[0].id]: { decision: 'duplicate', sent: '2026-10-06T10:00:00Z' } } });
  ctx.books.duplicates.assertWritable = () => {
    throw new FileLockedError(path.join(settings.dataDir, 'Duplicates.xlsx'));
  };
  assert.throws(() => saveSentDecisions(ctx, [kevin]), /Duplicates\.xlsx is open .* saved automatically once it is closed/);
  assert.equal(state.queue.length, 2);
  assert.match(state.applyError.message, /Duplicates\.xlsx is open/);
  assert.equal(state.resolved.length, 0);

  delete ctx.books.duplicates.assertWritable; // closed in Excel
  assert.equal(saveSentDecisions(ctx, [kevin]).duplicates, 1);
  assert.equal(state.applyError, null);
});

test('each person writes only their own file: drafts, sends, and leaving', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dupcheck-me-'));
  const id = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
  const team = new Team({ id, name: 'Kevin' });
  team.open(dataDir, { isHost: true, hostSince: '2026-10-01T00:00:00Z' });
  try {
    team.decide(['a', 'b'], 'duplicate');
    team.decide(['b'], null);
    assert.equal(team.send(new Set()), 1);
    team.decide(['a'], 'unique'); // already sent: unchanged
    const mine = readJson(personPath(dataDir, id));
    assert.equal(mine.role, 'host');
    assert.equal(mine.decisions.a.decision, 'duplicate');
    assert.ok(mine.decisions.a.sent);
    assert.equal('b' in mine.decisions, false);
  } finally {
    team.close();
  }
  assert.equal(readJson(personPath(dataDir, id)).open, false);

  // Coming back restores this person's unsent and sent decisions.
  const again = new Team({ id, name: 'Kevin' });
  again.open(dataDir, { isHost: false });
  assert.equal(again.me.decisions.a.decision, 'duplicate');
  assert.equal(again.me.role, 'reviewer');
  again.close();
});
