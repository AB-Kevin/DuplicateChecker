'use strict';

const fs = require('fs');
const path = require('path');

/** Reads JSON, falling back to `fallback` when the file is missing or unreadable. */
function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

/** Writes JSON beside the target and renames it into place. */
function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filePath);
}

module.exports = { readJson, writeJson };
