'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain, dialog, shell, Notification, Menu } = require('electron');
const { readJson, writeJson, defaultSettings, validateSettings } = require('./settings');
const { openBooks } = require('./books');
const { InboxWatcher } = require('./inbox');
const { importFile, applyDecisions, clearAllData, ImportError, tidyState } = require('./processor');
const { readHeaders, isSpreadsheet, SPREADSHEET_EXTENSIONS } = require('./spreadsheet');

const APP_ID = 'org.anabaptistbrotherhood.duplicatechecker';
const CLEAR_PHRASE = 'Clear ALL DATA'; // must match the Settings screen's confirmation

// A second copy would process the same inbox twice.
const isPrimaryInstance = app.requestSingleInstanceLock();
if (!isPrimaryInstance) app.quit();

let win = null;
let settings;
let state; // { queue: [...], log: [...] }
let books;
let watcher;

const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');
const statePath = () => path.join(app.getPath('userData'), 'review-state.json');
const defaults = () => defaultSettings(app.getPath('documents'));

function saveState() {
  writeJson(statePath(), state);
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

async function processInboxFile(filePath) {
  return exclusive(() => {
    const fileName = path.basename(filePath);
    if (!fs.existsSync(filePath)) return;
    try {
      const entry = importFile(filePath, { settings, books, state, saveState });
      if (entry.status === 'skipped') {
        notice('info', `${fileName} was already imported, so it was skipped.`);
      } else {
        notice('success', `${fileName}: ${count(entry.added, 'entry', 'entries')} added to the database, ${count(entry.flagged, 'entry', 'entries')} flagged for review.`);
        if (entry.flagged && Notification.isSupported() && !(win && win.isFocused())) {
          new Notification({
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
      output: settings.outputDir,
      database: books.database.filePath,
      duplicates: books.duplicates.filePath,
    },
    database: count(books.database),
    duplicates: count(books.duplicates),
    queue: state.queue,
    log: state.log.slice(0, 100),
    knownColumns: knownColumns(),
    watcher: watcher.status,
  };
}

// Called at startup or from within exclusive(), before the watcher (re)starts,
// so nothing else is writing the spreadsheets while they are tidied.
async function configure() {
  fs.mkdirSync(settings.outputDir, { recursive: true });
  books = openBooks(settings.outputDir);
  for (const book of [books.database, books.duplicates]) {
    try {
      book.tidy();
    } catch {
      // Open in Excel or unreadable; it is tidied the next time it is saved.
    }
  }
  await watcher.start(settings.inboxDir);
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
    const { settings: next, errors } = validateSettings(input, defaults());
    if (Object.keys(errors).length) return { errors };
    const foldersChanged = next.inboxDir !== settings.inboxDir || next.outputDir !== settings.outputDir;
    writeJson(settingsPath(), next);
    settings = next;
    if (foldersChanged) await exclusive(() => configure());
    watcher.rescan(true);
    stateChanged();
    return { settings };
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
    const wanted = new Set(ids);
    for (const item of state.queue) if (wanted.has(item.id)) item.decision = decision;
    saveState();
    stateChanged();
  });

  handle('review:apply', () => exclusive(() => {
    try {
      return applyDecisions({ settings, books, state, saveState });
    } finally {
      stateChanged();
    }
  }));

  handle('data:clear', (phrase) => {
    if (String(phrase ?? '').trim() !== CLEAR_PHRASE) throw new Error(`Type ${CLEAR_PHRASE} to confirm.`);
    return exclusive(() => {
      try {
        return clearAllData({ books, state, saveState });
      } finally {
        stateChanged();
      }
    });
  });

  handle('inbox:rescan', () => watcher.rescan(true));

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
      output: settings.outputDir,
      database: books.database.filePath,
      duplicates: books.duplicates.filePath,
    }[target];
    if (!where) throw new Error('Unknown location.');
    if (!fs.existsSync(where)) throw new Error(`${path.basename(where)} doesn't exist yet.`);
    const error = await shell.openPath(where);
    if (error) throw new Error(error);
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 980,
    minHeight: 640,
    title: 'Duplicate Checker',
    backgroundColor: '#FFFFFF',
    icon: path.join(__dirname, '..', 'renderer', 'assets', 'logo-circle-badge.jpg'),
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

  const stored = readJson(settingsPath(), null);
  settings = validateSettings(stored ?? {}, defaults()).settings;
  if (!stored) writeJson(settingsPath(), settings);
  state = { queue: [], log: [], ...readJson(statePath(), {}) };
  if (tidyState(state)) saveState();

  watcher = new InboxWatcher(processInboxFile);
  watcher.on('status', stateChanged);
  registerIpc();
  createWindow();
  await configure();
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', () => {
  if (watcher) watcher.stop();
});
