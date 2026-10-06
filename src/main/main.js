'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { app, BrowserWindow, ipcMain, dialog, shell, Notification, Menu } = require('electron');
const { defaultSettings, validateSettings, loadSettings, saveSettings } = require('./settings');
const { statePath, defaultInbox, samePath, summarize, copyData, loadState } = require('./datafolder');
const { writeJson } = require('./jsonfile');
const { openBooks } = require('./books');
const { InboxWatcher } = require('./inbox');
const { importFile, clearAllData, ImportError, tidyState } = require('./processor');
const { readHeaders, isSpreadsheet, SPREADSHEET_EXTENSIONS } = require('./spreadsheet');
const {
  Team, readPeople, isActive, activeHosts, firstSentDecisions, saveSentDecisions, settleDecisions, annotateQueue,
} = require('./team');

const APP_ID = 'org.anabaptistbrotherhood.duplicatechecker';
const CLEAR_PHRASE = 'Clear ALL DATA'; // must match the Settings screen's confirmation
// The same file electron-builder uses for the installer and .exe (package.json "build").
const APP_ICON = path.join(__dirname, '..', '..', 'build', 'icon.png');

// A second copy would process the same inbox twice.
const isPrimaryInstance = app.requestSingleInstanceLock();
if (!isPrimaryInstance) app.quit();

let win = null;
let settings;
let state; // { queue, log, resolved, applyError }, written only by the acting host
let books;
let watcher;
let team;
// This computer is set as host and no longer-serving host is active, so it
// imports files and writes the shared files. See team.js.
let actingHost = false;
let lastApplyError = null;

// Only this computer's settings are kept in the app's profile; see datafolder.js.
const localSettingsPath = () => path.join(app.getPath('userData'), 'settings.json');
// Where earlier versions kept the review queue and activity log.
const legacyStatePath = () => path.join(app.getPath('userData'), 'review-state.json');
const defaults = () => defaultSettings(app.getPath('documents'), os.userInfo().username);

/** Writes the shared review state. Only the acting host writes it. */
function saveState() {
  if (!actingHost) return;
  const { queue, ...rest } = state;
  // Decisions live in each person's own file, never in the shared queue.
  writeJson(statePath(settings.dataDir), { ...rest, queue: queue.map(({ decision, ...item }) => item) });
}

function readSharedState() {
  return { resolved: [], applyError: null, ...loadState(settings.dataDir, null) };
}

// Imports and decision saves both rewrite Database.xlsx, so they run one at a time.
let tail = Promise.resolve();
function exclusive(task) {
  const run = tail.then(task, task);
  tail = run.catch(() => {});
  return run;
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function notice(kind, message) {
  send('notice', { kind, message });
}

function stateChanged() {
  send('state-changed');
}

function count(n, one, many = `${one}s`) {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

function listNames(names) {
  return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

async function processInboxFile(filePath) {
  return exclusive(() => {
    const fileName = path.basename(filePath);
    if (!actingHost || !fs.existsSync(filePath)) return;
    try {
      const entry = importFile(filePath, { settings, books, state, saveState });
      if (entry.status === 'skipped') {
        notice('info', `${fileName} was already imported, so it was skipped.`);
      } else {
        notice('success', `${fileName}: ${count(entry.added, 'entry', 'entries')} added to the database, ${count(entry.flagged, 'entry', 'entries')} flagged for review.`);
        if (entry.flagged && Notification.isSupported() && !(win && win.isFocused())) {
          new Notification({
            icon: APP_ICON,
            title: 'Entries need review',
            body: `${count(entry.flagged, 'possible duplicate')} in ${fileName}.`,
          }).show();
        }
      }
    } catch (err) {
      const message = err instanceof ImportError || err.name === 'FileLockedError'
        ? err.message
        : `Unexpected error: ${err.message}`;
      state.log.unshift({ at: new Date().toISOString(), file: fileName, status: 'error', message, headers: err.headers });
      state.log.length = Math.min(state.log.length, 200);
      saveState();
      notice('error', `${fileName} was not imported. ${message}`);
      throw err;
    } finally {
      stateChanged();
    }
  });
}

// Host --------------------------------------------------------------------

/** Works out whether this computer acts as host, and starts or stops the host's work to match. */
async function updateRole() {
  const hosts = activeHosts(team.people());
  const shouldAct = settings.isHost && hosts[0]?.id === team.me.id;
  if (shouldAct === actingHost) return;
  actingHost = shouldAct;
  if (actingHost) {
    await becomeHost();
  } else {
    await watcher.stop();
    state = readSharedState();
  }
}

async function becomeHost() {
  // Start from the latest shared state, which another host may have written.
  state = { resolved: [], applyError: null, ...loadState(settings.dataDir, legacyStatePath()) };
  // Earlier versions kept decisions in the queue itself; they were this computer's.
  const legacy = state.queue.filter((item) => item.decision);
  if (legacy.length) {
    const at = new Date().toISOString();
    for (const item of legacy) team.me.decisions[item.id] ??= { decision: item.decision, at, sent: null };
    team.write();
  }
  tidyState(state);
  saveState();
  for (const book of [books.database, books.duplicates]) {
    try {
      book.tidy();
    } catch {
      // Open in Excel or unreadable; it is tidied the next time it is saved.
    }
  }
  await watcher.start(settings.inboxDir);
  autoApply();
}

/** Saves everyone's sent decisions to the spreadsheets, if this computer is acting as host. */
function applyPending() {
  if (!actingHost) return null;
  try {
    return saveSentDecisions({ settings, books, state, saveState }, team.people());
  } finally {
    settleMine();
  }
}

/** Saves decisions others have sent, telling the host what happened. */
function autoApply() {
  try {
    const result = applyPending();
    lastApplyError = null;
    if (result) {
      const names = team.people().filter((p) => result.people.includes(p.id) && p.id !== team.me.id).map((p) => p.name);
      const saved = count(result.duplicates + result.added, 'decision');
      notice('success', names.length ? `Saved ${saved} from ${listNames(names)}.` : `Saved ${saved} that were waiting.`);
    }
  } catch (err) {
    if (err.message !== lastApplyError) notice('error', err.message);
    lastApplyError = err.message;
  }
}

/** Clears this person's decisions on entries that are finished, and says what became of them. */
function settleMine() {
  const { changed, saved, overruled } = settleDecisions(team.me, state);
  if (!changed) return;
  try {
    team.write();
  } catch {
    // Written again on the next heartbeat.
  }
  if (saved.length && !actingHost) {
    notice('success', saved.length === 1
      ? 'Your decision was saved to the spreadsheets.'
      : `Your ${saved.length} decisions were saved to the spreadsheets.`);
  }
  if (overruled.length === 1) {
    const [r] = overruled;
    notice('info', `Row ${r.rowNumber} of ${r.fileName} was already marked ${r.decision === 'duplicate' ? 'a duplicate' : 'not a duplicate'} by ${r.name}, so your decision wasn't used.`);
  } else if (overruled.length) {
    notice('info', `${overruled.length} of your decisions weren't used because someone else decided those entries first.`);
  }
}

// Snapshot ----------------------------------------------------------------

function knownColumns() {
  const seen = new Map();
  const add = (headers) => {
    for (const h of headers ?? []) {
      const key = h.toLowerCase();
      if (!seen.has(key)) seen.set(key, h);
    }
  };
  try {
    add(books.database.load().headers);
  } catch {
    // Unreadable database; the Activity screen reports it.
  }
  for (const item of state.queue) add(item.headers);
  for (const entry of state.log) add(entry.headers);
  return [...seen.values()];
}

function teamInfo() {
  if (!team.me) return { role: 'reviewer', host: null, otherHosts: [], people: [], applyError: null, waitingToSave: 0 };
  const now = Date.now();
  const people = team.people();
  const hosts = activeHosts(people, now);
  return {
    role: actingHost ? 'host' : settings.isHost ? 'waiting-host' : 'reviewer',
    host: hosts[0] ? { name: hosts[0].name, isMe: hosts[0].id === team.me.id } : null,
    otherHosts: hosts.slice(1).map((h) => h.name),
    people: people
      .filter((p) => p.id === team.me.id || isActive(p, now))
      .map((p) => {
        const viewing = state.queue.find((item) => item.id === p.viewing);
        return {
          name: p.name,
          computer: p.computer,
          role: hosts[0]?.id === p.id ? 'host' : 'reviewer',
          isMe: p.id === team.me.id,
          viewing: viewing ? `${viewing.fileName}, row ${viewing.rowNumber}` : null,
        };
      }),
    applyError: state.applyError ?? null,
    waitingToSave: firstSentDecisions(people, state.queue).size,
  };
}

function snapshot() {
  const count = (book) => {
    try {
      return { rows: book.load().rows.length, error: null };
    } catch (err) {
      return { rows: null, error: err.message };
    }
  };
  return {
    settings,
    paths: {
      inbox: settings.inboxDir,
      data: settings.dataDir,
      database: books.database.filePath,
      duplicates: books.duplicates.filePath,
    },
    database: count(books.database),
    duplicates: count(books.duplicates),
    queue: team.me ? annotateQueue(state.queue, team.me, team.people()) : state.queue,
    log: state.log.slice(0, 100),
    knownColumns: knownColumns(),
    watcher: watcher.status,
    team: teamInfo(),
  };
}

// Data folder -------------------------------------------------------------

/** Joins the data folder: announces this person, loads the shared state, and takes up hosting if elected. */
async function openDataFolder() {
  actingHost = false;
  await watcher.stop();
  fs.mkdirSync(settings.dataDir, { recursive: true });
  books = openBooks(settings.dataDir);
  team.open(settings.dataDir, { isHost: settings.isHost, hostSince: settings.hostSince });
  state = readSharedState();
  await updateRole();
  settleMine();
}

/**
 * Asks what to do when the data folder is changed: 'use' a folder that
 * already has data, 'copy' the current data into an empty one, or start
 * 'empty'. Returns null if the user cancels.
 */
async function planDataFolderChange(fromDir, toDir, hostThere) {
  const target = summarize(toDir);
  if (target.inUse) {
    const parts = [count(target.reviewItems, 'entry', 'entries') + ' waiting for review'];
    if (target.database) parts.push('a database');
    const role = hostThere
      ? `${hostThere.name}'s computer is its host, so you'll join as a reviewer.`
      : 'Its matching settings will replace the ones on the Settings screen.';
    const { response } = await dialog.showMessageBox(win, {
      type: 'question',
      title: 'Use this data folder?',
      message: 'This folder already has Duplicate Checker data.',
      detail: `${toDir}\n\nIt has ${parts.join(' and ')}. ${role} Nothing in the current data folder is changed.`,
      buttons: ['Use this folder', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    return response === 0 ? 'use' : null;
  }

  const current = summarize(fromDir);
  if (!current.hasData) return 'empty';
  const { response } = await dialog.showMessageBox(win, {
    type: 'question',
    title: 'Copy your data?',
    message: 'Copy your data to the new data folder?',
    detail: `The new folder is empty. Copy the database, duplicates, ${count(current.reviewItems, 'entry', 'entries')} waiting for review, the activity log, processed files and backups from:\n${fromDir}\n\nThe old folder is left as it is. You can delete it once you've checked the new one.`,
    buttons: ['Copy my data', 'Start empty', 'Cancel'],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  });
  return ['copy', 'empty', null][response];
}

function uniqueTarget(dir, name) {
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  let target = path.join(dir, name);
  for (let n = 2; fs.existsSync(target); n++) target = path.join(dir, `${base} (${n})${ext}`);
  return target;
}

function copyIntoInbox(filePaths) {
  fs.mkdirSync(settings.inboxDir, { recursive: true });
  const accepted = filePaths.filter((p) => p && isSpreadsheet(p) && fs.statSync(p).isFile());
  for (const source of accepted) {
    fs.copyFileSync(source, uniqueTarget(settings.inboxDir, path.basename(source)));
  }
  return { copied: accepted.length, ignored: filePaths.length - accepted.length };
}

// IPC ---------------------------------------------------------------------

/** Registers an IPC handler that returns { ok, value } or { ok: false, error }. */
function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return { ok: true, value: await fn(...args) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
}

function registerIpc() {
  handle('state:get', () => snapshot());

  handle('settings:save', async (input) => {
    const { settings: next, errors } = validateSettings(
      { ...input, personId: settings.personId, hostSince: settings.hostSince },
      defaults(),
    );
    if (Object.keys(errors).length) return { errors };
    if (next.isHost && !settings.isHost) next.hostSince = new Date().toISOString();
    if (!next.isHost) next.hostSince = null;

    const dataChanged = !samePath(next.dataDir, settings.dataDir);
    // An inbox kept in the data folder's Inbox folder moves with the data folder.
    const inboxFollows = dataChanged && samePath(next.inboxDir, settings.inboxDir)
      && samePath(settings.inboxDir, defaultInbox(settings.dataDir));
    if (inboxFollows) next.inboxDir = defaultInbox(next.dataDir);

    const hostThere = dataChanged
      ? activeHosts(readPeople(next.dataDir).filter((p) => p.id !== settings.personId))[0] ?? null
      : null;
    const plan = dataChanged ? await planDataFolderChange(settings.dataDir, next.dataDir, hostThere) : 'keep';
    if (!plan) return { cancelled: true };
    if (hostThere) {
      next.isHost = false; // join a folder someone else is hosting as a reviewer
      next.hostSince = null;
    }

    await exclusive(async () => {
      if (plan === 'copy') {
        await watcher.stop();
        copyData(settings.dataDir, next.dataDir, { includeInbox: inboxFollows, personId: settings.personId });
      }
      const inboxChanged = !samePath(next.inboxDir, settings.inboxDir);
      const roleChanged = next.isHost !== settings.isHost;
      saveSettings(localSettingsPath(), next, { localOnly: true });
      settings = next;
      if (dataChanged) {
        team.close();
        await openDataFolder();
      } else {
        if (team.me.name !== next.personName) team.setName(next.personName);
        if (roleChanged) team.setRole(next.isHost, next.hostSince);
        await updateRole();
        if (inboxChanged && actingHost) await watcher.start(settings.inboxDir);
      }
      // Only the host changes the shared settings; everyone else uses the folder's.
      if (actingHost && plan !== 'use') saveSettings(localSettingsPath(), settings);
      settings = loadSettings(localSettingsPath(), defaults()).settings;
    });
    if (actingHost) watcher.rescan(true);
    stateChanged();
    return { settings, plan, role: teamInfo().role };
  });

  handle('dialog:folder', async (current) => {
    const result = await dialog.showOpenDialog(win, {
      defaultPath: current || undefined,
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  handle('dialog:columns', async () => {
    const result = await dialog.showOpenDialog(win, {
      title: 'Choose a spreadsheet to read column names from',
      properties: ['openFile'],
      filters: [{ name: 'Spreadsheets', extensions: SPREADSHEET_EXTENSIONS.map((e) => e.slice(1)) }],
    });
    if (result.canceled) return null;
    return readHeaders(result.filePaths[0]);
  });

  handle('review:decide', (ids, decision) => {
    if (![null, 'duplicate', 'unique'].includes(decision)) throw new Error('Unknown decision.');
    // Entries someone else has already sent a decision for are settled.
    const taken = firstSentDecisions(team.others, state.queue);
    team.decide(ids.filter((id) => !taken.has(id)), decision);
    stateChanged();
  });

  handle('review:viewing', (itemId) => {
    team.setViewing(itemId ?? null);
  });

  handle('review:apply', () => exclusive(() => {
    try {
      const taken = new Set(firstSentDecisions(team.others, state.queue).keys());
      const sent = team.send(taken);
      let saved = null;
      if (actingHost) {
        try {
          saved = applyPending();
          lastApplyError = null;
        } catch (err) {
          lastApplyError = err.message; // shown now, so the automatic retries stay quiet
          throw err;
        }
      }
      return { sent, saved, host: teamInfo().host };
    } finally {
      stateChanged();
    }
  }));

  handle('data:clear', (phrase) => {
    if (String(phrase ?? '').trim() !== CLEAR_PHRASE) throw new Error(`Type ${CLEAR_PHRASE} to confirm.`);
    if (!actingHost) throw new Error('Only the host computer can clear all data.');
    return exclusive(() => {
      try {
        const removed = clearAllData({ books, state, saveState });
        state.resolved = [];
        state.applyError = null;
        saveState();
        team.me.decisions = {};
        team.write();
        return removed;
      } finally {
        stateChanged();
      }
    });
  });

  handle('inbox:rescan', () => {
    if (!actingHost) throw new Error('Only the host computer imports files from the inbox.');
    return watcher.rescan(true);
  });

  handle('inbox:choose', async () => {
    const result = await dialog.showOpenDialog(win, {
      title: 'Add spreadsheets to the inbox',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Spreadsheets', extensions: SPREADSHEET_EXTENSIONS.map((e) => e.slice(1)) }],
    });
    return result.canceled ? { copied: 0, ignored: 0 } : copyIntoInbox(result.filePaths);
  });

  handle('inbox:add', (filePaths) => copyIntoInbox(filePaths));

  handle('open', async (target) => {
    const where = {
      inbox: settings.inboxDir,
      data: settings.dataDir,
      database: books.database.filePath,
      duplicates: books.duplicates.filePath,
    }[target];
    if (!where) throw new Error('Unknown location.');
    if (!fs.existsSync(where)) throw new Error(`${path.basename(where)} doesn't exist yet.`);
    const error = await shell.openPath(where);
    if (error) throw new Error(error);
  });
}

function watchTeam() {
  // Someone arrived, left, made a decision or sent some: re-check who is
  // host, and as host, save anything newly sent.
  team.on('people', () => exclusive(async () => {
    await updateRole();
    if (actingHost) autoApply();
    stateChanged();
  }));
  // The host saved the review queue: everyone else reloads it.
  team.on('state-file', () => exclusive(() => {
    if (actingHost) return;
    state = readSharedState();
    settleMine();
    stateChanged();
  }));
  team.on('settings-file', () => exclusive(() => {
    if (actingHost) return;
    settings = loadSettings(localSettingsPath(), defaults()).settings;
    stateChanged();
  }));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 980,
    minHeight: 640,
    title: 'Duplicate Checker',
    backgroundColor: '#FFFFFF',
    icon: APP_ICON,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.on('closed', () => {
    win = null;
  });
}

app.on('second-instance', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

app.whenReady().then(async () => {
  if (!isPrimaryInstance) return;
  app.setAppUserModelId(APP_ID);
  Menu.setApplicationMenu(null);

  const loaded = loadSettings(localSettingsPath(), defaults());
  settings = loaded.settings;
  settings.personId ??= crypto.randomUUID();
  if (settings.isHost && !settings.hostSince) settings.hostSince = new Date().toISOString();
  state = { queue: [], log: [], resolved: [], applyError: null };
  books = openBooks(settings.dataDir);
  watcher = new InboxWatcher(processInboxFile);
  watcher.on('status', stateChanged);
  team = new Team({ id: settings.personId, name: settings.personName });
  watchTeam();
  registerIpc();
  createWindow();

  try {
    // Rewrites the local file with this computer's settings only, and gives a
    // data folder without settings of its own (a new one, or one from an
    // earlier version) the current matching settings.
    saveSettings(localSettingsPath(), settings, { localOnly: loaded.sharedFound });
    await openDataFolder();
  } catch (err) {
    dialog.showErrorBox(
      'Data folder unavailable',
      `The data folder could not be opened:\n${settings.dataDir}\n\n${err.message}\n\nChoose a different data folder in Settings.`,
    );
  }
  stateChanged();
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', () => {
  if (watcher) watcher.stop();
  if (team) team.close(); // tells everyone else this person has left
});
