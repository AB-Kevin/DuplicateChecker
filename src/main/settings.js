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
    requiredFields: [], // columns that must always match
    fields: [], // columns where at least `threshold` must match
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

  // A column belongs to one list only; the must-match list wins.
  const seen = new Set();
  const cleanList = (list) => (Array.isArray(list) ? list : [])
    .map((f) => String(f).replace(/\s+/g, ' ').trim())
    .filter((f) => {
      const key = f.toLowerCase();
      if (!f || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  settings.requiredFields = cleanList(settings.requiredFields);
  settings.fields = cleanList(settings.fields);

  // The count only applies when there are columns where some must match.
  const threshold = Number(settings.threshold);
  const count = settings.fields.length;
  if (!count) {
    settings.threshold = Number.isInteger(threshold) && threshold >= 1 ? threshold : defaults.threshold;
  } else {
    if (!Number.isInteger(threshold) || threshold < 1) {
      errors.threshold = 'Enter a whole number of 1 or more.';
    } else if (threshold > count) {
      errors.threshold = `Can't be more than the ${count} column${count === 1 ? '' : 's'} checked in this list.`;
    }
    settings.threshold = threshold;
  }

  const retentionDays = Number(settings.retentionDays);
  if (!Number.isInteger(retentionDays) || retentionDays < 0) {
    errors.retentionDays = 'Enter a whole number of days, or 0 to keep entries indefinitely.';
  }
  settings.retentionDays = retentionDays;

  return { settings, errors };
}

module.exports = { readJson, writeJson, defaultSettings, validateSettings };
