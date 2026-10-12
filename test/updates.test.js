'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { parseVersion, isNewer, parseLatestYml, checkForUpdate, downloadInstaller } = require('../src/main/updates');

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dupcheck-update-'));
const sha512 = (bytes) => crypto.createHash('sha512').update(bytes).digest('base64');
const DIGEST = sha512('installer');

/** A stand-in for net.fetch that answers every request with `body`, and counts the requests. */
function fakeFetch(body, { status = 200 } = {}) {
  const fetch = async (url) => {
    fetch.calls++;
    fetch.url = url;
    return new Response(body, { status });
  };
  fetch.calls = 0;
  return fetch;
}

/** A latest.yml as electron-builder writes it. */
function latestYml(version, { name = `DuplicateChecker-Setup-${version}.exe`, digest = DIGEST, size = 1234 } = {}) {
  return [
    `version: ${version}`,
    'files:',
    `  - url: ${name}`,
    `    sha512: ${digest}`,
    `    size: ${size}`,
    `path: ${name}`,
    `sha512: ${digest}`,
    "releaseDate: '2026-10-06T02:30:27.123Z'",
    '',
  ].join('\n');
}

test('versions are compared part by part, as numbers', () => {
  assert.deepEqual(parseVersion('v1.10.0'), [1, 10, 0]);
  assert.equal(parseVersion('1.0'), null);
  assert.equal(parseVersion('v1.1.0-beta.1'), null);
  assert.equal(isNewer('1.10.0', '1.9.9'), true);
  assert.equal(isNewer('v2.0.0', '1.99.99'), true);
  assert.equal(isNewer('1.0.0', '1.0.0'), false);
  assert.equal(isNewer('1.0.0', '1.0.1'), false);
  assert.equal(isNewer('nonsense', '1.0.0'), false);
});

test('latest.yml is read without a YAML library', () => {
  assert.deepEqual(parseLatestYml(latestYml('1.2.0').replaceAll('\n', '\r\n')), {
    version: '1.2.0',
    files: [{ url: 'DuplicateChecker-Setup-1.2.0.exe', sha512: DIGEST, size: 1234 }],
    path: 'DuplicateChecker-Setup-1.2.0.exe',
    sha512: DIGEST,
    releaseDate: '2026-10-06T02:30:27.123Z',
  });
});

test('a newer release is reported with its installer and digest', async () => {
  const fetch = fakeFetch(latestYml('1.2.0'));
  const result = await checkForUpdate('1.0.0', fetch);
  assert.equal(fetch.url, 'https://github.com/AB-Kevin/DuplicateChecker/releases/latest/download/latest.yml');
  assert.equal(result.version, '1.2.0');
  assert.equal(result.newer, true);
  assert.equal(result.publishedAt, '2026-10-06T02:30:27.123Z');
  assert.equal(result.pageUrl, 'https://github.com/AB-Kevin/DuplicateChecker/releases/tag/v1.2.0');
  assert.deepEqual(result.installer, {
    name: 'DuplicateChecker-Setup-1.2.0.exe',
    size: 1234,
    url: 'https://github.com/AB-Kevin/DuplicateChecker/releases/download/v1.2.0/DuplicateChecker-Setup-1.2.0.exe',
    sha512: DIGEST,
  });

  const same = await checkForUpdate('1.2.0', fakeFetch(latestYml('1.2.0')));
  assert.equal(same.newer, false);
});

test('only this version\'s installer, with a digest and size, is offered', async () => {
  const wrongName = await checkForUpdate('1.0.0', fakeFetch(latestYml('1.2.0', { name: 'Something-else.exe' })));
  assert.equal(wrongName.installer, null);

  const elsewhere = await checkForUpdate('1.0.0', fakeFetch(latestYml('1.2.0', { name: 'https://example.com/DuplicateChecker-Setup-1.2.0.exe' })));
  assert.equal(elsewhere.installer, null);

  const noDigest = await checkForUpdate('1.0.0', fakeFetch(latestYml('1.2.0', { digest: '' })));
  assert.equal(noDigest.installer, null);

  const noSize = await checkForUpdate('1.0.0', fakeFetch(latestYml('1.2.0', { size: 'big' })));
  assert.equal(noSize.installer, null);
});

test('problems reaching GitHub are explained', async () => {
  await assert.rejects(checkForUpdate('1.0.0', fakeFetch('', { status: 404 })), /No release is ready/);
  await assert.rejects(checkForUpdate('1.0.0', fakeFetch('', { status: 403 })), /limiting/);
  await assert.rejects(checkForUpdate('1.0.0', fakeFetch('', { status: 500 })), /error 500/);
  await assert.rejects(checkForUpdate('1.0.0', async () => { throw new TypeError('fetch failed'); }), /Couldn't reach GitHub/);
  await assert.rejects(checkForUpdate('1.0.0', fakeFetch('version: latest\n')), /version number/);
  await assert.rejects(checkForUpdate('1.0.0', fakeFetch('<html>Not a release</html>')), /version number/);
});

test('the installer is downloaded, checked against its digest, and reused', async () => {
  const dir = tempDir();
  const bytes = crypto.randomBytes(200000).toString('base64');
  const installer = { name: 'DuplicateChecker-Setup-1.2.0.exe', size: bytes.length, url: 'https://x', sha512: sha512(bytes) };
  const fetch = fakeFetch(bytes);
  const progress = [];

  const filePath = await downloadInstaller(installer, dir, fetch, (received, total) => progress.push([received, total]));
  assert.equal(filePath, path.join(dir, installer.name));
  assert.equal(fs.readFileSync(filePath, 'utf8'), bytes);
  assert.deepEqual(progress.at(-1), [bytes.length, bytes.length]);
  assert.deepEqual(fs.readdirSync(dir), [installer.name]);

  assert.equal(await downloadInstaller(installer, dir, fetch), filePath);
  assert.equal(fetch.calls, 1);
});

test('a download that doesn\'t match the release is thrown away', async () => {
  const dir = tempDir();
  const installer = { name: 'DuplicateChecker-Setup-1.2.0.exe', size: 5, url: 'https://x', sha512: sha512('right') };
  await assert.rejects(downloadInstaller(installer, dir, fakeFetch('wrong')), /didn't match/);
  await assert.rejects(downloadInstaller({ ...installer, size: 99 }, dir, fakeFetch('right')), /didn't match/);
  await assert.rejects(downloadInstaller(installer, dir, fakeFetch('', { status: 500 })), /couldn't be downloaded/);
  assert.deepEqual(fs.readdirSync(dir), []);
});
