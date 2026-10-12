'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { once } = require('events');

// Releases are published here by .github/workflows/release.yml, each with the
// latest.yml electron-builder writes beside the installer. Reading that file
// from the latest release's download link, rather than asking the GitHub API,
// avoids the API's limit of 60 requests an hour per network. AB Apps reads the
// same file to install and update this app.
const REPO = 'AB-Kevin/DuplicateChecker';
const RELEASES_PAGE = `https://github.com/${REPO}/releases`;
const LATEST_YML_URL = `${RELEASES_PAGE}/latest/download/latest.yml`;

/** The installer's name, as set by package.json "build.nsis.artifactName". */
const installerName = (version) => `DuplicateChecker-Setup-${version}.exe`;

/** Splits "1.2.3" or "v1.2.3" into [1, 2, 3], or returns null. */
function parseVersion(text) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(text ?? '').trim());
  return match ? match.slice(1).map(Number) : null;
}

/** Whether version `a` is later than version `b`. */
function isNewer(a, b) {
  const [x, y] = [parseVersion(a), parseVersion(b)];
  if (!x || !y) return false;
  const i = x.findIndex((part, n) => part !== y[n]);
  return i >= 0 && x[i] > y[i];
}

/** Removes the quotes YAML may put around a value. */
const unquote = (value) => value.trim().replace(/^'(.*)'$|^"(.*)"$/, '$1$2');

/**
 * Reads the parts of an electron-builder latest.yml this app uses:
 * { version, releaseDate, files: [{ url, sha512, size }] }. The file is
 * always this flat shape, so a full YAML parser isn't needed.
 */
function parseLatestYml(text) {
  const info = { files: [] };
  for (const line of String(text).split(/\r?\n/)) {
    const top = /^(\w+):(.*)$/.exec(line);
    if (top) {
      if (top[1] !== 'files') info[top[1]] = unquote(top[2]);
      continue;
    }
    const item = /^\s*(-\s+)?(url|sha512|size):(.*)$/.exec(line);
    if (!item) continue;
    if (item[1]) info.files.push({});
    const file = info.files.at(-1);
    if (file) file[item[2]] = item[2] === 'size' ? Number(unquote(item[3])) : unquote(item[3]);
  }
  return info;
}

/**
 * Reads latest.yml from GitHub's latest release, so drafts and pre-releases
 * are never offered. Returns { version, newer, publishedAt, pageUrl,
 * installer }, where installer is { name, size, url, sha512 } or null if the
 * release has no installer. `fetch` is Electron's net.fetch, which uses
 * Windows' proxy settings.
 */
async function checkForUpdate(currentVersion, fetch) {
  let response;
  try {
    response = await fetch(LATEST_YML_URL, { signal: AbortSignal.timeout(20000) });
  } catch {
    throw new Error("Couldn't reach GitHub to check for updates. Check the internet connection and try again.");
  }
  if (response.status === 404) throw new Error('No release is ready yet. If one was just published, try again in a few minutes.');
  if (response.status === 403 || response.status === 429) {
    throw new Error('GitHub is limiting how often this computer can check for updates. Try again in an hour.');
  }
  if (!response.ok) throw new Error(`GitHub couldn't be checked for updates (error ${response.status}). Try again later.`);

  const latest = parseLatestYml(await response.text());
  const version = String(latest.version ?? '').replace(/^v/, '');
  if (!parseVersion(version)) {
    throw new Error(`The latest release, ${latest.version || 'with no version'}, doesn't have a version number this app recognizes.`);
  }
  // Only ever download this repository's installer for this version.
  const file = latest.files.find((f) => f.url === installerName(version)
    && /^[A-Za-z0-9+/]{86}==$/.test(f.sha512 ?? '') && Number.isSafeInteger(f.size) && f.size > 0);
  const tag = `v${version}`;
  return {
    version,
    newer: isNewer(version, currentVersion),
    publishedAt: latest.releaseDate || null,
    pageUrl: `${RELEASES_PAGE}/tag/${tag}`,
    installer: file
      ? { name: file.url, size: file.size, url: `${RELEASES_PAGE}/download/${tag}/${file.url}`, sha512: file.sha512 }
      : null,
  };
}

/** Whether `filePath` is the installer described, judged by its size and SHA-512 digest. */
async function isInstaller(filePath, { size, sha512 }) {
  try {
    if (!sha512 || fs.statSync(filePath).size !== size) return false;
    const hash = crypto.createHash('sha512');
    for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
    return hash.digest('base64') === sha512;
  } catch {
    return false;
  }
}

/**
 * Downloads the installer into `dir`, checking it against the size and
 * SHA-512 digest latest.yml gave for it. One already downloaded is reused.
 * Calls onProgress(received, total) as it goes. Returns the file's path.
 */
async function downloadInstaller(installer, dir, fetch, onProgress = () => {}) {
  const target = path.join(dir, installer.name);
  if (await isInstaller(target, installer)) return target;

  fs.mkdirSync(dir, { recursive: true });
  const partPath = `${target}.part`;
  const hash = crypto.createHash('sha512');
  let received = 0;
  const out = fs.createWriteStream(partPath);
  try {
    const response = await fetch(installer.url);
    if (!response.ok) throw new Error(`error ${response.status}`);
    for await (const chunk of response.body) {
      hash.update(chunk);
      received += chunk.length;
      if (!out.write(chunk)) await once(out, 'drain');
      onProgress(received, installer.size);
    }
    out.end();
    await once(out, 'close'); // Windows won't run a file that is still open for writing
  } catch {
    out.destroy();
    fs.rmSync(partPath, { force: true });
    throw new Error("The update couldn't be downloaded. Check the internet connection and try again.");
  }

  if (received !== installer.size || hash.digest('base64') !== installer.sha512) {
    fs.rmSync(partPath, { force: true });
    throw new Error("The downloaded update didn't match the release on GitHub, so it wasn't installed. Try again.");
  }
  fs.renameSync(partPath, target);
  return target;
}

module.exports = { RELEASES_PAGE, parseVersion, isNewer, parseLatestYml, checkForUpdate, downloadInstaller };
