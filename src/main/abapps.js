'use strict';

// Sign-in comes from AB Apps, the office's launcher, when it's there; reading
// it is ab-common's (abapps.js). While someone is signed in, Duplicate
// Checker shows their AB Apps name to the others using the data folder
// instead of the one typed in Settings, and records the AB Apps person in its
// person file, so one person on two computers counts once. Only a manager may
// change the matching settings or clear all data (canManage). Each computer
// still writes its own person file, since OneDrive can't merge two writers.
// Without AB Apps, or with nobody signed in, the Settings name is used and
// the host decides, as before. Like AB Apps' PIN, this is a convenience, not
// a security boundary.

const { identityPath, readIdentity, watchIdentity } = require('ab-common/abapps');

/**
 * Whether this computer may change the matching and retention settings and
 * clear all data: the acting host, and while someone is signed in to AB
 * Apps, only if they're a manager. Without AB Apps, the host can, as before.
 */
function canManage(actingHost, identity) {
  return actingHost && (!identity || identity.class === 'manager');
}

module.exports = { identityPath, readIdentity, watchIdentity, canManage };
