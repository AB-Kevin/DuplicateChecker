'use strict';

// Watches the inbox folder and hands each spreadsheet that lands there to
// `processFile`, one at a time. A file that fails is not retried until it
// changes on disk or the user asks for a rescan, so a bad file doesn't fill
// the activity log. A periodic rescan covers network folders, where change
// notifications are unreliable.

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const chokidar = require('chokidar');
const { isSpreadsheet } = require('./spreadsheet');

const RESCAN_INTERVAL_MS = 60 * 1000;

class InboxWatcher extends EventEmitter {
  constructor(processFile) {
    super();
    this.processFile = processFile;
    this.dir = null;
    this.watcher = null;
    this.timer = null;
    this.pending = new Set();
    this.failed = new Map(); // path -> mtime when it failed
    this.status = { state: 'stopped', message: '' };
  }

  setStatus(state, message = '') {
    this.status = { state, message };
    this.emit('status', this.status);
  }

  isInInbox(filePath) {
    return path.resolve(path.dirname(filePath)).toLowerCase() === this.dir.toLowerCase();
  }

  async start(dir) {
    await this.stop();
    dir = path.resolve(dir);
    this.dir = dir;
    this.failed.clear();
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (err) {
      this.setStatus('error', `Can't open the inbox folder: ${err.message}`);
      return;
    }

    this.watcher = chokidar.watch(dir, {
      depth: 0,
      ignoreInitial: false,
      awaitWriteFinish: { stabilityThreshold: 1500, pollInterval: 250 },
      ignored: (p, stats) => p !== dir && stats?.isFile() === true && !isSpreadsheet(p),
    });
    this.watcher
      .on('add', (p) => this.enqueue(p))
      .on('change', (p) => this.enqueue(p))
      .on('ready', () => this.setStatus('watching'))
      .on('error', (err) => this.setStatus('error', err.message));
    this.timer = setInterval(() => this.rescan(false), RESCAN_INTERVAL_MS);
  }

  async stop() {
    clearInterval(this.timer);
    this.timer = null;
    if (this.watcher) await this.watcher.close();
    this.watcher = null;
    this.setStatus('stopped');
  }

  mtime(filePath) {
    try {
      return fs.statSync(filePath).mtimeMs;
    } catch {
      return null;
    }
  }

  enqueue(filePath, force = false) {
    if (!this.dir || !this.isInInbox(filePath) || !isSpreadsheet(filePath) || this.pending.has(filePath)) return;
    const mtime = this.mtime(filePath);
    if (mtime === null) return;
    if (!force && this.failed.get(filePath) === mtime) return;

    this.pending.add(filePath);
    Promise.resolve()
      .then(() => this.processFile(filePath))
      .then(
        () => this.failed.delete(filePath),
        () => this.failed.set(filePath, mtime),
      )
      .finally(() => this.pending.delete(filePath));
  }

  /** Queues every spreadsheet in the inbox. `force` retries files that failed before. */
  rescan(force = true) {
    if (!this.dir) return 0;
    let names = [];
    try {
      names = fs.readdirSync(this.dir);
    } catch (err) {
      this.setStatus('error', `Can't read the inbox folder: ${err.message}`);
      return 0;
    }
    const files = names.map((n) => path.join(this.dir, n)).filter(isSpreadsheet);
    for (const file of files) this.enqueue(file, force);
    return files.length;
  }
}

module.exports = { InboxWatcher };
