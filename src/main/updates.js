'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { once } = require('events');

// Releases are published here by .github/workflows/release.yml.
const REPO = 'AB-Kevin/DuplicateChecker';
const LATEST_RELEASE_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASES_PAGE = `https://github.com/${REPO}/releases`;

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

/**
 * Asks GitHub for the latest release. Returns { version, newer, publishedAt,
 * pageUrl, installer }, where installer is { name, size, url, sha256 } or null
 * if the release has no installer. `fetch` is Electron's net.fetch, which uses
 * Windows' proxy settings.
 */
async function checkForUpdate(currentVersion, fetch) {
  let response;
  try {
    response = await fetch(LATEST_RELEASE_URL, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw new Error("Couldn't reach GitHub to check for updates. Check the internet connection and try again.");
  }
  if (response.status === 404) throw new Error('No releases have been published yet.');
  if (response.status === 403 || response.status === 429) {
    throw new Error('GitHub is limiting how often this computer can check for updates. Try again in an hour.');
  }
  if (!response.ok) throw new Error(`GitHub couldn't be checked for updates (error ${response.status}). Try again later.`);

  const release = await response.json();
  const version = String(release.tag_name ?? '').replace(/^v/, '');
  if (!parseVersion(version)) {
    throw new Error(`The latest release, ${release.tag_name}, doesn't have a version number this app recognizes.`);
  }
  // Only ever download this repository's installer for this version.
  const asset = (release.assets ?? []).find((a) => a.name === installerName(version)
    && a.browser_download_url === `${RELEASES_PAGE}/download/${release.tag_name}/${a.name}`);
  const sha256 = /^sha256:([0-9a-f]{64})$/i.exec(asset?.digest ?? '')?.[1].toLowerCase() ?? null;
  return {
    version,
    newer: isNewer(version, currentVersion),
    publishedAt: release.published_at ?? null,
    pageUrl: `${RELEASES_PAGE}/tag/${encodeURIComponent(release.tag_name)}`,
    installer: asset ? { name: asset.name, size: asset.size, url: asset.browser_download_url, sha256 } : null,
  };
}

/** Whether `filePath` is the installer described, judged by its size and SHA-256 digest. */
async function isInstaller(filePath, { size, sha256 }) {
  try {
    if (!sha256 || fs.statSync(filePath).size !== size) return false;
    const hash = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
    return hash.digest('hex') === sha256;
  } catch {
    return false;
  }
}

/**
 * Downloads the installer into `dir`, checking it against the size and
 * SHA-256 digest GitHub gave for it. One already downloaded is reused.
 * Calls onProgress(received, total) as it goes. Returns the file's path.
 */
async function downloadInstaller(installer, dir, fetch, onProgress = () => {}) {
  const target = path.join(dir, installer.name);
  if (await isInstaller(target, installer)) return target;

  fs.mkdirSync(dir, { recursive: true });
  const partPath = `${target}.part`;
  const hash = crypto.createHash('sha256');
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

  if (received !== installer.size || (installer.sha256 && hash.digest('hex') !== installer.sha256)) {
    fs.rmSync(partPath, { force: true });
    throw new Error("The downloaded update didn't match the release on GitHub, so it wasn't installed. Try again.");
  }
  fs.renameSync(partPath, target);
  return target;
}

module.exports = { RELEASES_PAGE, parseVersion, isNewer, checkForUpdate, downloadInstaller };
