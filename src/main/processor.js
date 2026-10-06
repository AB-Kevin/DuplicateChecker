'use strict';

// Importing a spreadsheet from the inbox and applying review decisions.
//
// Import: every row is compared against the database (after expired entries
// are dropped), against rows still awaiting review, and against earlier rows
// of the same file. Rows that match nothing go straight into the database;
// rows that match on enough columns go to the review queue.
//
// Apply: rows marked as duplicates are appended to Duplicates.xlsx, rows
// marked as not duplicates are appended to Database.xlsx.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readTable } = require('./spreadsheet');
const { normalizeHeader, resolveFields, pickValues, MatchIndex } = require('../shared/matcher');
const { DATABASE_META, DUPLICATES_META, localDate, retentionFilter } = require('./books');

const MAX_MATCHES_KEPT = 5;
const MAX_LOG_ENTRIES = 200;

/**
 * A file that can't be imported as it stands; it stays in the inbox. Carries
 * the file's column names when they could be read, so Settings can offer them.
 */
class ImportError extends Error {
  constructor(message, headers = []) {
    super(message);
    this.name = 'ImportError';
    this.headers = headers;
  }
}

function fileHash(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

/** Renames incoming columns that collide with the app's bookkeeping columns. */
function renameReservedHeaders({ headers, rows }) {
  const reserved = new Set([...DATABASE_META, ...DUPLICATES_META].map(normalizeHeader));
  const renamed = headers.map((h) => (reserved.has(normalizeHeader(h)) ? `${h} (original)` : h));
  if (renamed.every((h, i) => h === headers[i])) return { headers, rows };
  return {
    headers: renamed,
    rows: rows.map(({ rowNumber, values }) => ({
      rowNumber,
      values: Object.fromEntries(headers.map((h, i) => [renamed[i], values[h]])),
    })),
  };
}

function effectiveThreshold(settings) {
  return Math.min(Math.max(1, settings.threshold), settings.fields.length);
}

/** Moves a file into the Processed folder, prefixed with the time it was handled. */
function moveToProcessed(filePath, outputDir, now) {
  const dir = path.join(outputDir, 'Processed');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = `${localDate(now)} ${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
  const target = path.join(dir, `${stamp} ${path.basename(filePath)}`);
  try {
    fs.renameSync(filePath, target);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err; // different drive: copy, then delete
    fs.copyFileSync(filePath, target);
    fs.rmSync(filePath);
  }
  return target;
}

function addLogEntry(state, entry) {
  state.log.unshift(entry);
  state.log.length = Math.min(state.log.length, MAX_LOG_ENTRIES);
}

/**
 * Imports one spreadsheet. `ctx` is { settings, books: { database }, state,
 * saveState(), now }. Returns the activity-log entry describing the result.
 * Throws ImportError (file left in the inbox) when the file cannot be
 * imported as it stands, or FileLockedError when Database.xlsx is open.
 */
function importFile(filePath, ctx) {
  const { settings, books, state } = ctx;
  const now = ctx.now ?? new Date();
  const fileName = path.basename(filePath);

  const hash = fileHash(filePath);
  const earlier = state.log.find((e) => e.hash === hash && e.status === 'imported');
  if (earlier) {
    const entry = {
      at: now.toISOString(),
      file: fileName,
      status: 'skipped',
      message: `Identical to ${earlier.file}, imported ${localDate(earlier.at)}. Moved to Processed without importing.`,
    };
    moveToProcessed(filePath, settings.outputDir, now);
    addLogEntry(state, entry);
    ctx.saveState();
    return entry;
  }

  let table;
  try {
    table = renameReservedHeaders(readTable(filePath));
  } catch (err) {
    throw new ImportError(`Could not read the spreadsheet: ${err.message}`);
  }

  if (!settings.fields.length) {
    throw new ImportError('Choose the columns to compare in Settings. The file will be imported once they are saved.', table.headers);
  }
  const threshold = effectiveThreshold(settings);
  const fileFields = resolveFields(table.headers, settings.fields);
  const missing = settings.fields.filter((_, i) => !fileFields[i]);
  if (settings.fields.length - missing.length < threshold) {
    throw new ImportError(
      `Missing column${missing.length === 1 ? '' : 's'} ${missing.map((m) => `"${m}"`).join(', ')}. ` +
      `At least ${threshold} of the ${settings.fields.length} compare columns must be present.`,
      table.headers,
    );
  }

  // Everything already known: the database (minus expired entries), then
  // rows awaiting review from earlier files.
  const database = books.database.load();
  const keep = retentionFilter(settings.retentionDays, now);
  const index = new MatchIndex(settings.fields.length);
  const dbFields = resolveFields(database.headers, settings.fields);
  for (const row of database.rows) {
    if (keep && !keep(row)) continue;
    index.add({
      kind: 'database',
      sourceFile: row.meta['Source File'] ?? '',
      sourceRow: row.meta['Source Row'] ?? '',
      dateAdded: row.meta['Date Added'] ?? '',
      headers: database.headers,
      record: row.values,
    }, pickValues(row.values, dbFields));
  }
  for (const item of state.queue) {
    index.add({
      kind: 'queue',
      sourceFile: item.fileName,
      sourceRow: item.rowNumber,
      headers: item.headers,
      record: item.record,
    }, pickValues(item.record, resolveFields(item.headers, settings.fields)));
  }

  const importedAt = now.toISOString();
  const clean = [];
  const flagged = [];
  for (const row of table.rows) {
    const values = pickValues(row.values, fileFields);
    const matches = index.find(values, threshold);
    if (matches.length) {
      flagged.push({
        id: crypto.randomUUID(),
        fileName,
        importedAt,
        rowNumber: row.rowNumber,
        headers: table.headers,
        record: row.values,
        fields: [...settings.fields],
        threshold,
        matchCount: matches.length,
        matches: matches.slice(0, MAX_MATCHES_KEPT).map(({ entry, fields }) => ({
          ...entry,
          fields: fields.map((f) => settings.fields[f]),
        })),
        decision: null,
      });
    } else {
      clean.push(row);
    }
    index.add({
      kind: 'batch',
      sourceFile: fileName,
      sourceRow: row.rowNumber,
      headers: table.headers,
      record: row.values,
    }, values);
  }

  const today = localDate(now);
  const result = books.database.commit({
    append: clean.map((row) => ({
      values: row.values,
      headers: table.headers,
      meta: { 'Date Added': today, 'Source File': fileName, 'Source Row': String(row.rowNumber) },
    })),
    keep,
  });

  state.queue.push(...flagged);
  const entry = {
    at: importedAt,
    file: fileName,
    status: 'imported',
    hash,
    headers: table.headers,
    rows: table.rows.length,
    added: clean.length,
    flagged: flagged.length,
    expired: result.removed,
    missingFields: missing,
  };
  if (missing.length) {
    entry.message = `Compared without ${missing.map((m) => `"${m}"`).join(', ')} (not in this file).`;
  }
  addLogEntry(state, entry);
  ctx.saveState();

  // The import is recorded by now, so if the move fails the file is
  // recognized as already imported the next time it is seen.
  try {
    moveToProcessed(filePath, settings.outputDir, now);
  } catch (err) {
    entry.message = [entry.message, `Imported, but could not move the file to Processed: ${err.message}`]
      .filter(Boolean).join(' ');
    ctx.saveState();
  }
  return entry;
}

/** A one-line description of where a matched entry came from. */
function describeMatch(match) {
  if (!match) return '';
  if (match.kind === 'database') {
    const where = [match.sourceFile, match.sourceRow && `row ${match.sourceRow}`].filter(Boolean).join(', ');
    return `Database entry${where ? ` from ${where}` : ''}${match.dateAdded ? `, added ${match.dateAdded}` : ''}`;
  }
  if (match.kind === 'batch') return `Row ${match.sourceRow} of the same file`;
  return `Row ${match.sourceRow} of ${match.sourceFile}`;
}

/**
 * Writes every decided queue item to its spreadsheet and removes it from the
 * queue. Both spreadsheets are checked for locks first so a decision batch is
 * not half-applied because Excel has one of them open.
 */
function applyDecisions(ctx) {
  const { settings, books, state } = ctx;
  const now = ctx.now ?? new Date();
  const duplicates = state.queue.filter((item) => item.decision === 'duplicate');
  const unique = state.queue.filter((item) => item.decision === 'unique');
  if (!duplicates.length && !unique.length) return { duplicates: 0, added: 0, expired: 0 };

  if (duplicates.length) books.duplicates.assertWritable();
  if (unique.length) books.database.assertWritable();

  const removeFromQueue = (items) => {
    const ids = new Set(items.map((item) => item.id));
    state.queue = state.queue.filter((item) => !ids.has(item.id));
    ctx.saveState();
  };

  const today = localDate(now);
  if (duplicates.length) {
    books.duplicates.commit({
      append: duplicates.map((item) => ({
        values: item.record,
        headers: item.headers,
        meta: {
          'Date Reviewed': today,
          'Source File': item.fileName,
          'Source Row': String(item.rowNumber),
          'Matched On': (item.matches[0]?.fields ?? []).join(', '),
          'Duplicate Of': describeMatch(item.matches[0]),
        },
      })),
    });
    removeFromQueue(duplicates);
  }

  let expired = 0;
  if (unique.length) {
    const result = books.database.commit({
      append: unique.map((item) => ({
        values: item.record,
        headers: item.headers,
        meta: {
          'Date Added': localDate(item.importedAt),
          'Source File': item.fileName,
          'Source Row': String(item.rowNumber),
        },
      })),
      keep: retentionFilter(settings.retentionDays, now),
    });
    expired = result.removed;
    removeFromQueue(unique);
  }

  return { duplicates: duplicates.length, added: unique.length, expired };
}

module.exports = { ImportError, importFile, applyDecisions, describeMatch, effectiveThreshold };
