'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readJson, writeJson } = require('../src/main/jsonfile');

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dupcheck-json-'));

test('a missing file gives the fallback, and a written one reads back', () => {
  const file = path.join(tempDir(), 'App data', 'state.json');
  assert.deepEqual(readJson(file, { queue: [] }), { queue: [] });
  writeJson(file, { queue: [{ id: 'a' }] });
  assert.deepEqual(readJson(file, null), { queue: [{ id: 'a' }] });
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['state.json'], 'no temporary file is left behind');
});

test('a damaged file throws instead of giving the fallback', () => {
  const file = path.join(tempDir(), 'state.json');
  fs.writeFileSync(file, '{"queue": [');
  assert.throws(() => readJson(file, {}), /damaged/);
});

test('a file OneDrive has locked is read once it is free', (t) => {
  const file = path.join(tempDir(), 'state.json');
  writeJson(file, { queue: [{ id: 'a' }] });
  const read = fs.readFileSync;
  let busy = 2;
  t.mock.method(fs, 'readFileSync', (...args) => {
    if (busy-- > 0) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
    return read(...args);
  });
  assert.deepEqual(readJson(file, {}), { queue: [{ id: 'a' }] });
});

test('a file that stays locked throws instead of giving the fallback', (t) => {
  const file = path.join(tempDir(), 'state.json');
  writeJson(file, { queue: [{ id: 'a' }] });
  t.mock.method(fs, 'readFileSync', () => {
    throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
  });
  assert.throws(() => readJson(file, {}), /Couldn't read state\.json/);
});
