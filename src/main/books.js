'use strict';

// Database.xlsx and Duplicates.xlsx. Each is a single sheet whose columns are
// the union of every imported file's columns, followed by a few bookkeeping
// columns the app fills in (date added, source file, ...). The spreadsheet on
// disk is the source of truth; it is re-read whenever it changes on disk, so
// edits made in Excel are respected.

const fs = require('fs');
const path = require('path');
const { readTable, writeTable, isGeneratedHeader } = require('./spreadsheet');
const { normalizeHeader, resolveHeader, parseDate } = require('../shared/matcher');

const DATABASE_META = ['Date Added', 'Source File', 'Source Row'];
const DUPLICATES_META = ['Date Reviewed', 'Source File', 'Source Row', 'Matched On', 'Duplicate Of'];
const BACKUPS_TO_KEEP = 30;

class FileLockedError extends Error {
  constructor(filePath) {
    super(`${path.basename(filePath)} is open in another program (usually Excel). Close it and try again.`);
    this.name = 'FileLockedError';
  }
}

function isLockError(err) {
  return ['EBUSY', 'EPERM', 'EACCES'].includes(err && err.code);
}

/** yyyy-mm-dd in local time. */
function localDate(date = new Date()) {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** yyyy-mm-dd hhmmss in local time, for file names. */
function localTimestamp(date = new Date()) {
  const d = new Date(date);
  const time = [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join('');
  return `${localDate(d)} ${time}`;
}

/**
 * Returns a predicate that keeps database rows added within the last
 * `days` days, or null when entries are kept indefinitely. Rows whose date
 * cannot be read are kept rather than silently dropped.
 */
function retentionFilter(days, now = new Date()) {
  if (!days || days <= 0) return null;
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffIso = localDate(cutoff);
  return (row) => {
    const added = parseDate(row.meta['Date Added'] ?? '');
    return !added || added >= cutoffIso;
  };
}

class DataBook {
  constructor({ filePath, sheetName, metaHeaders, backupDir }) {
    this.filePath = filePath;
    this.sheetName = sheetName;
    this.metaHeaders = metaHeaders;
    this.backupDir = backupDir;
    this.headers = [];
    this.rows = [];
    this.loadedMtime = undefined;
    this.needsTidy = false;
  }

  get name() {
    return path.basename(this.filePath);
  }

  /** Re-reads the spreadsheet if it changed on disk since the last read. */
  load() {
    let mtime = null;
    try {
      mtime = fs.statSync(this.filePath).mtimeMs;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    if (mtime === this.loadedMtime) return this;

    this.needsTidy = false;
    if (mtime === null) {
      this.headers = [];
      this.rows = [];
    } else {
      const table = readTable(this.filePath);
      const metaKeys = new Set(this.metaHeaders.map(normalizeHeader));
      const metaFor = (h) => this.metaHeaders.find((m) => normalizeHeader(m) === normalizeHeader(h));
      this.headers = table.headers.filter((h) => !metaKeys.has(normalizeHeader(h)));
      this.rows = table.rows.map(({ values }) => {
        const row = { values: {}, meta: {} };
        for (const [header, value] of Object.entries(values)) {
          if (metaKeys.has(normalizeHeader(header))) row.meta[metaFor(header)] = value;
          else row.values[header] = value;
        }
        return row;
      });

      // Earlier versions saved empty, unnamed columns ("Column V") that came
      // from formatting past the last column of an imported file.
      const empty = this.headers.filter((h) => isGeneratedHeader(h) && this.rows.every((row) => !row.values[h]));
      if (empty.length) {
        this.headers = this.headers.filter((h) => !empty.includes(h));
        for (const row of this.rows) for (const h of empty) delete row.values[h];
        this.needsTidy = true;
      }
    }
    this.loadedMtime = mtime;
    return this;
  }

  /**
   * Copies the file to the backups folder, then deletes it. Returns the
   * backup's path, or null if there was no file.
   */
  clear(now = new Date()) {
    if (!fs.existsSync(this.filePath)) return null;
    this.assertWritable();
    const base = path.basename(this.filePath, path.extname(this.filePath));
    const backup = path.join(this.backupDir, `${base} before clearing ${localTimestamp(now)}.xlsx`);
    fs.mkdirSync(this.backupDir, { recursive: true });
    fs.copyFileSync(this.filePath, backup);
    try {
      fs.rmSync(this.filePath);
    } catch (err) {
      if (isLockError(err)) throw new FileLockedError(this.filePath);
      throw err;
    }
    this.headers = [];
    this.rows = [];
    this.loadedMtime = null; // matches load()'s "no file"
    this.needsTidy = false;
    return backup;
  }

  /** Saves the file if load() dropped leftover empty columns from it. Returns true if it did. */
  tidy() {
    this.load();
    if (!this.needsTidy) return false;
    this.save(this.headers, this.rows);
    return true;
  }

  /** Throws FileLockedError if another program has the file open for writing. */
  assertWritable() {
    let fd;
    try {
      fd = fs.openSync(this.filePath, 'r+');
    } catch (err) {
      if (err.code === 'ENOENT') return;
      if (isLockError(err)) throw new FileLockedError(this.filePath);
      throw err;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }

  /**
   * Appends rows and optionally drops rows that fail `keep`, then saves.
   * Each appended item is { values, headers, meta }, where headers are the
   * source file's column names; they are matched to existing columns by name
   * (ignoring case and spacing) and new columns are added at the end.
   * The in-memory copy only changes once the file has been written.
   */
  commit({ append = [], keep = null } = {}) {
    this.load();
    const headers = [...this.headers];
    const mappings = new Map();
    const mappingFor = (sourceHeaders) => {
      const key = sourceHeaders.join('\u0001');
      if (!mappings.has(key)) {
        mappings.set(key, sourceHeaders.map((h) => {
          const existing = resolveHeader(headers, h);
          if (existing) return existing;
          headers.push(h);
          return h;
        }));
      }
      return mappings.get(key);
    };

    const added = append.map(({ values, headers: sourceHeaders, meta }) => {
      const target = mappingFor(sourceHeaders);
      const row = { values: {}, meta: { ...meta } };
      sourceHeaders.forEach((h, i) => {
        row.values[target[i]] = values[h] ?? '';
      });
      return row;
    });

    const kept = keep ? this.rows.filter(keep) : this.rows;
    const removed = this.rows.length - kept.length;
    if (!added.length && !removed) return { added: 0, removed: 0 };

    const rows = kept.concat(added);
    this.save(headers, rows);
    this.headers = headers;
    this.rows = rows;
    return { added: added.length, removed };
  }

  save(headers, rows) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.assertWritable();
    this.backup();
    const allHeaders = [...headers, ...this.metaHeaders];
    try {
      writeTable(this.filePath, {
        sheetName: this.sheetName,
        headers: allHeaders,
        rows: rows.map((row) => ({ ...row.values, ...row.meta })),
      });
    } catch (err) {
      if (isLockError(err)) throw new FileLockedError(this.filePath);
      throw err;
    }
    this.loadedMtime = fs.statSync(this.filePath).mtimeMs;
    this.needsTidy = false;
  }

  /** Keeps the first version of the file from each day, up to BACKUPS_TO_KEEP days. */
  backup() {
    if (!this.backupDir || !fs.existsSync(this.filePath)) return;
    const base = path.basename(this.filePath, path.extname(this.filePath));
    const target = path.join(this.backupDir, `${base} ${localDate()}.xlsx`);
    if (fs.existsSync(target)) return;
    fs.mkdirSync(this.backupDir, { recursive: true });
    fs.copyFileSync(this.filePath, target);

    const pattern = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\d{4}-\\d{2}-\\d{2}\\.xlsx$`);
    const old = fs.readdirSync(this.backupDir).filter((f) => pattern.test(f)).sort().reverse().slice(BACKUPS_TO_KEEP);
    for (const file of old) fs.rmSync(path.join(this.backupDir, file), { force: true });
  }
}

function openBooks(dataDir) {
  const backupDir = path.join(dataDir, 'Backups');
  return {
    database: new DataBook({
      filePath: path.join(dataDir, 'Database.xlsx'),
      sheetName: 'Database',
      metaHeaders: DATABASE_META,
      backupDir,
    }),
    duplicates: new DataBook({
      filePath: path.join(dataDir, 'Duplicates.xlsx'),
      sheetName: 'Duplicates',
      metaHeaders: DUPLICATES_META,
      backupDir,
    }),
  };
}

module.exports = {
  DATABASE_META,
  DUPLICATES_META,
  DataBook,
  FileLockedError,
  isLockError,
  localDate,
  localTimestamp,
  retentionFilter,
  openBooks,
};
