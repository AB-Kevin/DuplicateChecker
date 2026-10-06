'use strict';

// The data folder holds everything the app keeps, so it can live in OneDrive
// and be handed to someone else:
//
//   Database.xlsx, Duplicates.xlsx
//   App data/settings.json      matching rules and retention
//   App data/review-state.json  entries waiting for review, and the activity log
//   Processed/, Backups/
//   Inbox/                      the default inbox
//
// Only the folder locations are kept on each computer.

const fs = require('fs');
const path = require('path');
const { readJson, writeJson } = require('./jsonfile');

const APP_DATA = 'App data';
const DATA_ITEMS = ['Database.xlsx', 'Duplicates.xlsx', APP_DATA, 'Processed', 'Backups'];

const sharedSettingsPath = (dataDir) => path.join(dataDir, APP_DATA, 'settings.json');
const statePath = (dataDir) => path.join(dataDir, APP_DATA, 'review-state.json');
const defaultInbox = (dataDir) => path.join(dataDir, 'Inbox');

function samePath(a, b) {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

/** What a data folder holds, for deciding what to do when switching to it. */
function summarize(dataDir) {
  const state = readJson(statePath(dataDir), {});
  const summary = {
    configured: fs.existsSync(sharedSettingsPath(dataDir)),
    database: fs.existsSync(path.join(dataDir, 'Database.xlsx')),
    duplicates: fs.existsSync(path.join(dataDir, 'Duplicates.xlsx')),
    reviewItems: state.queue?.length ?? 0,
    logEntries: state.log?.length ?? 0,
  };
  summary.hasData = summary.database || summary.duplicates || summary.reviewItems > 0 || summary.logEntries > 0;
  summary.inUse = summary.configured || summary.hasData;
  return summary;
}

/**
 * Copies everything in one data folder to another, never overwriting. The
 * inbox comes along when it is the data folder's own Inbox folder.
 */
function copyData(from, to, { includeInbox }) {
  fs.mkdirSync(to, { recursive: true });
  const items = includeInbox ? [...DATA_ITEMS, 'Inbox'] : DATA_ITEMS;
  for (const item of items) {
    const source = path.join(from, item);
    if (fs.existsSync(source)) {
      fs.cpSync(source, path.join(to, item), { recursive: true, force: false, errorOnExist: false });
    }
  }
}

/**
 * Loads the review queue and activity log. Earlier versions kept them in the
 * app's profile folder (`legacyPath`); if the data folder has none yet, that
 * file is moved in and renamed so it isn't moved again.
 */
function loadState(dataDir, legacyPath) {
  const file = statePath(dataDir);
  if (!fs.existsSync(file) && legacyPath && fs.existsSync(legacyPath)) {
    writeJson(file, readJson(legacyPath, {}));
    fs.renameSync(legacyPath, `${legacyPath}.moved-to-data-folder`);
  }
  return { queue: [], log: [], ...readJson(file, {}) };
}

module.exports = {
  APP_DATA,
  sharedSettingsPath,
  statePath,
  defaultInbox,
  samePath,
  summarize,
  copyData,
  loadState,
};
