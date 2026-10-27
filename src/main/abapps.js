'use strict';

// Sign-in comes from AB Apps, the office's launcher, when it's there. While
// someone is signed in, AB Apps keeps who it is in this Windows account's
// AppData:
//
//   %APPDATA%\AB Apps\identity.json
//   { "version": 1, "personId", "name", "class", "signedInAt", "dataDir" }
//
// Duplicate Checker then shows that name to the others using the data folder
// instead of the one typed in Settings, and records the AB Apps person in its
// person file, so one person on two computers counts once. Only a manager may
// change the matching settings or clear all data (canManage). Each computer
// still writes its own person file, since OneDrive can't merge two writers.
// Without AB Apps, or with nobody signed in, the Settings name is used and
// the host decides, as before. Like AB Apps' PIN, this is a convenience, not
// a security boundary.

const fs = require('fs');
const path = require('path');
const { readJson } = require('./jsonfile');

const CLASSES = ['manager', 'employee', 'contractor'];

/** AB Apps' folder in AppData, or AB_APPS_PROFILE, which AB Apps also honors, for test runs. */
const identityDir = (appDataDir) => process.env.AB_APPS_PROFILE || path.join(appDataDir, 'AB Apps');
const identityPath = (appDataDir) => path.join(identityDir(appDataDir), 'identity.json');

/** Who is signed in to AB Apps: { personId, name, class }, or null. */
function readIdentity(appDataDir) {
  let identity;
  try {
    identity = readJson(identityPath(appDataDir), null);
  } catch {
    return null; // mid-write, or damaged: the same as signed out until AB Apps writes it again
  }
  if (identity?.version !== 1) return null;
  const name = typeof identity.name === 'string' ? identity.name.replace(/\s+/g, ' ').trim() : '';
  if (!/^[0-9a-f-]{36}$/i.test(identity.personId ?? '') || !name || name.length > 80) return null;
  if (!CLASSES.includes(identity.class)) return null;
  return { personId: identity.personId, name, class: identity.class };
}

/**
 * Calls onChange(identity) when someone signs in to AB Apps, signs out, or is
 * renamed, checking every two seconds. Returns a function that stops it.
 */
function watchIdentity(appDataDir, onChange) {
  const file = identityPath(appDataDir);
  let last = JSON.stringify(readIdentity(appDataDir));
  const check = () => {
    const next = readIdentity(appDataDir);
    if (JSON.stringify(next) === last) return;
    last = JSON.stringify(next);
    onChange(next);
  };
  fs.watchFile(file, { interval: 2000 }, check);
  return () => fs.unwatchFile(file, check);
}

/**
 * Whether this computer may change the matching and retention settings and
 * clear all data: the acting host, and while someone is signed in to AB
 * Apps, only if they're a manager. Without AB Apps, the host can, as before.
 */
function canManage(actingHost, identity) {
  return actingHost && (!identity || identity.class === 'manager');
}

module.exports = { identityPath, readIdentity, watchIdentity, canManage };
