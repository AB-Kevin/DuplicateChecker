'use strict';

const path = require('path');
const { readJson, writeJson } = require('./jsonfile');
const { sharedSettingsPath, defaultInbox, samePath } = require('./datafolder');

// Folder locations differ from computer to computer, so they are kept in the
// app's profile. Everything else travels with the data folder.
const LOCAL_KEYS = ['dataDir', 'inboxDir'];
const SHARED_KEYS = ['requiredFields', 'fields', 'threshold', 'retentionDays'];

const pick = (object, keys) => Object.fromEntries(keys.filter((k) => k in object).map((k) => [k, object[k]]));

function defaultSettings(documentsDir) {
  const dataDir = path.join(documentsDir, 'Duplicate Checker');
  return {
    dataDir,
    inboxDir: defaultInbox(dataDir),
    requiredFields: [], // columns that must always match
    fields: [], // columns where at least `threshold` must match
    threshold: 3,
    retentionDays: 365,
  };
}

/**
 * Cleans up settings from the Settings screen. Returns { settings, errors },
 * where errors maps a setting name to a message.
 */
function validateSettings(input, defaults) {
  const errors = {};
  const settings = { ...defaults, ...input };

  for (const key of LOCAL_KEYS) {
    settings[key] = String(settings[key] ?? '').trim();
    if (!settings[key]) errors[key] = 'Choose a folder.';
    else if (!path.isAbsolute(settings[key])) errors[key] = 'Use a full folder path.';
  }
  if (!errors.inboxDir && !errors.dataDir && samePath(settings.inboxDir, settings.dataDir)) {
    errors.inboxDir = 'The inbox must be a different folder from the data folder. Its Inbox folder works well.';
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

  return { settings: pick(settings, [...LOCAL_KEYS, ...SHARED_KEYS]), errors };
}

/**
 * Reads the folder locations from `localPath` and the rest from the data
 * folder. Settings files from before the data folder held everything named it
 * `outputDir` and kept the matching rules locally; those rules are used until
 * the data folder has its own. Returns { settings, sharedFound }.
 */
function loadSettings(localPath, defaults) {
  const stored = readJson(localPath, {});
  const dataDir = stored.dataDir ?? stored.outputDir ?? defaults.dataDir;
  const shared = readJson(sharedSettingsPath(dataDir), null);
  const { settings } = validateSettings({
    ...pick(stored, LOCAL_KEYS),
    dataDir,
    ...(shared ? pick(shared, SHARED_KEYS) : pick(stored, SHARED_KEYS)),
  }, defaults);
  return { settings, sharedFound: Boolean(shared) };
}

/** Writes the folder locations to `localPath`, and unless `localOnly`, the rest to the data folder. */
function saveSettings(localPath, settings, { localOnly = false } = {}) {
  writeJson(localPath, pick(settings, LOCAL_KEYS));
  if (!localOnly) writeJson(sharedSettingsPath(settings.dataDir), pick(settings, SHARED_KEYS));
}

module.exports = { LOCAL_KEYS, SHARED_KEYS, defaultSettings, validateSettings, loadSettings, saveSettings };
