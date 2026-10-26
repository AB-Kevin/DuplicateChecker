'use strict';

const fs = require('fs');
const path = require('path');

// OneDrive briefly locks a file while it uploads it.
const BUSY = new Set(['EPERM', 'EBUSY', 'EACCES']);

function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function retry(action) {
  for (let attempt = 1; ; attempt++) {
    try {
      return action();
    } catch (err) {
      if (attempt >= 6 || !BUSY.has(err.code)) throw err;
      pause(100 * attempt);
    }
  }
}

/**
 * Reads JSON, returning `fallback` only when the file doesn't exist. Any other
 * failure throws: treating an unreadable file as empty and then saving would
 * erase whatever was in it.
 */
function readJson(filePath, fallback) {
  let text;
  try {
    text = retry(() => fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw new Error(`Couldn't read ${path.basename(filePath)}: ${err.message}`);
  }
  try {
    return JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    throw new Error(`${filePath} is damaged and can't be read. Restore it from OneDrive's version history.`);
  }
}

/** Writes JSON beside the target and renames it into place, so a reader never sees half a file. */
function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  retry(() => fs.renameSync(tempPath, filePath));
}

module.exports = { readJson, writeJson };
