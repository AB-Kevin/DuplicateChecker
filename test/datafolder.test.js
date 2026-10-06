'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readJson, writeJson } = require('../src/main/jsonfile');
const { defaultSettings, loadSettings, saveSettings } = require('../src/main/settings');
const { sharedSettingsPath, statePath, summarize, copyData, loadState } = require('../src/main/datafolder');

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dupcheck-data-'));

test('settings from earlier versions move their matching rules into the data folder', () => {
  const root = tempDir();
  const localPath = path.join(root, 'profile', 'settings.json');
  const dataDir = path.join(root, 'Data');
  writeJson(localPath, {
    inboxDir: path.join(root, 'Inbox'),
    outputDir: dataDir, // the data folder's earlier name
    requiredFields: ['PatientName'],
    fields: ['CPT Code', 'Charge Amount'],
    threshold: 1,
    retentionDays: 90,
  });
  const defaults = defaultSettings(path.join(root, 'Documents'));

  const first = loadSettings(localPath, defaults);
  assert.equal(first.sharedFound, false);
  assert.equal(first.settings.dataDir, dataDir);
  assert.deepEqual(first.settings.requiredFields, ['PatientName']);
  assert.equal(first.settings.retentionDays, 90);

  saveSettings(localPath, first.settings);
  assert.deepEqual(readJson(localPath), { dataDir, inboxDir: path.join(root, 'Inbox') });
  assert.deepEqual(readJson(sharedSettingsPath(dataDir)), {
    requiredFields: ['PatientName'], fields: ['CPT Code', 'Charge Amount'], threshold: 1, retentionDays: 90,
  });

  const again = loadSettings(localPath, defaults);
  assert.equal(again.sharedFound, true);
  assert.deepEqual(again.settings, first.settings);
});

test("a data folder's own settings win over this computer's", () => {
  const root = tempDir();
  const localPath = path.join(root, 'profile', 'settings.json');
  const dataDir = path.join(root, 'Shared');
  writeJson(localPath, { dataDir, inboxDir: path.join(dataDir, 'Inbox'), fields: ['Local'], threshold: 1 });
  writeJson(sharedSettingsPath(dataDir), { requiredFields: ['Member ID'], fields: ['A', 'B'], threshold: 2, retentionDays: 30 });

  const { settings } = loadSettings(localPath, defaultSettings(root));
  assert.deepEqual(settings.requiredFields, ['Member ID']);
  assert.deepEqual(settings.fields, ['A', 'B']);
  assert.equal(settings.retentionDays, 30);
  assert.equal(settings.inboxDir, path.join(dataDir, 'Inbox'));
});

test('the review queue from the app profile moves into the data folder once', () => {
  const root = tempDir();
  const legacy = path.join(root, 'profile', 'review-state.json');
  const dataDir = path.join(root, 'Data');
  writeJson(legacy, { queue: [{ id: 'a' }], log: [{ file: 'w.xlsx' }] });

  const state = loadState(dataDir, legacy);
  assert.deepEqual(state.queue, [{ id: 'a' }]);
  assert.equal(fs.existsSync(statePath(dataDir)), true);
  assert.equal(fs.existsSync(legacy), false);
  assert.equal(fs.existsSync(`${legacy}.moved-to-data-folder`), true);

  // A data folder that already has its own queue keeps it.
  writeJson(legacy, { queue: [{ id: 'stale' }], log: [] });
  assert.deepEqual(loadState(dataDir, legacy).queue, [{ id: 'a' }]);
});

test('copying a data folder brings everything and never overwrites', () => {
  const root = tempDir();
  const from = path.join(root, 'Old');
  const to = path.join(root, 'OneDrive', 'Duplicate Checker');
  for (const file of ['Database.xlsx', 'Duplicates.xlsx', 'Processed/2026-10-05 week.xlsx', 'Backups/Database 2026-10-05.xlsx', 'Inbox/waiting.xlsx']) {
    fs.mkdirSync(path.dirname(path.join(from, file)), { recursive: true });
    fs.writeFileSync(path.join(from, file), file);
  }
  writeJson(statePath(from), { queue: [{ id: 'a' }, { id: 'b' }], log: [] });
  writeJson(sharedSettingsPath(from), { fields: ['A'] });

  const before = summarize(from);
  assert.equal(before.hasData, true);
  assert.equal(before.reviewItems, 2);
  assert.equal(summarize(to).inUse, false);

  fs.mkdirSync(to, { recursive: true });
  fs.writeFileSync(path.join(to, 'Duplicates.xlsx'), 'already here');
  copyData(from, to, { includeInbox: false });

  assert.equal(fs.readFileSync(path.join(to, 'Database.xlsx'), 'utf8'), 'Database.xlsx');
  assert.equal(fs.readFileSync(path.join(to, 'Duplicates.xlsx'), 'utf8'), 'already here');
  assert.equal(fs.existsSync(path.join(to, 'Processed', '2026-10-05 week.xlsx')), true);
  assert.equal(fs.existsSync(path.join(to, 'Backups', 'Database 2026-10-05.xlsx')), true);
  assert.equal(fs.existsSync(path.join(to, 'Inbox')), false);
  assert.deepEqual(readJson(statePath(to)).queue.map((i) => i.id), ['a', 'b']);
  assert.equal(summarize(to).inUse, true);

  copyData(from, to, { includeInbox: true });
  assert.equal(fs.existsSync(path.join(to, 'Inbox', 'waiting.xlsx')), true);
});
