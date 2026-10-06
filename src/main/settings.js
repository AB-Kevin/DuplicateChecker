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

function defaultSettings(documentsDir) {
  const base = path.join(documentsDir, 'Duplicate Checker');
  return {
    inboxDir: path.join(base, 'Inbox'),
    outputDir: base,
    fields: [],
    threshold: 3,
    retentionDays: 365,
  };
}

function samePath(a, b) {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

/**
 * Cleans up settings from the Settings screen. Returns { settings, errors },
 * where errors maps a setting name to a message.
 */
function validateSettings(input, defaults) {
  const errors = {};
  const settings = { ...defaults, ...input };

  for (const key of ['inboxDir', 'outputDir']) {
    settings[key] = String(settings[key] ?? '').trim();
    if (!settings[key]) errors[key] = 'Choose a folder.';
    else if (!path.isAbsolute(settings[key])) errors[key] = 'Use a full folder path.';
  }
  if (!errors.inboxDir && !errors.outputDir && samePath(settings.inboxDir, settings.outputDir)) {
    errors.inboxDir = 'The inbox must be a different folder from the output folder.';
  }

  const seen = new Set();
  settings.fields = (Array.isArray(settings.fields) ? settings.fields : [])
    .map((f) => String(f).replace(/\s+/g, ' ').trim())
    .filter((f) => {
      const key = f.toLowerCase();
      if (!f || seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  const threshold = Number(settings.threshold);
  if (!Number.isInteger(threshold) || threshold < 1) {
    errors.threshold = 'Enter a whole number of 1 or more.';
  } else if (settings.fields.length && threshold > settings.fields.length) {
    errors.threshold = `Can't be more than the ${settings.fields.length} selected column${settings.fields.length === 1 ? '' : 's'}.`;
  }
  settings.threshold = threshold;

  const retentionDays = Number(settings.retentionDays);
  if (!Number.isInteger(retentionDays) || retentionDays < 0) {
    errors.retentionDays = 'Enter a whole number of days, or 0 to keep entries indefinitely.';
  }
  settings.retentionDays = retentionDays;

  return { settings, errors };
}

module.exports = { readJson, writeJson, defaultSettings, validateSettings };
