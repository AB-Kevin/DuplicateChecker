'use strict';

// Reading and writing spreadsheets. Every value is carried as the text Excel
// displays for it, which keeps leading zeros and long IDs intact. On write,
// text that is plainly a number, amount or date goes back in as a real Excel
// number or date so the output files can still be summed and sorted.

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const SPREADSHEET_EXTENSIONS = ['.xlsx', '.xlsm', '.xls', '.csv', '.ods'];

function isSpreadsheet(filePath) {
  const name = path.basename(filePath);
  if (name.startsWith('~$') || name.startsWith('.')) return false; // Office lock files, temp files
  return SPREADSHEET_EXTENSIONS.includes(path.extname(name).toLowerCase());
}

function uniqueHeaders(rawHeaders) {
  const seen = new Map();
  return rawHeaders.map((raw, i) => {
    let header = String(raw ?? '').replace(/\s+/g, ' ').trim() || `Column ${XLSX.utils.encode_col(i)}`;
    const key = header.toLowerCase();
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    if (count > 1) header = `${header} (${count})`;
    return header;
  });
}

/**
 * Reads the first worksheet. The first non-blank row is the header row.
 * Returns { sheetName, headers, rows: [{ rowNumber, values: {header: text} }] }
 * where rowNumber is the row as numbered in Excel.
 */
function readTable(filePath) {
  const buffer = fs.readFileSync(filePath);
  // raw: true stops CSV parsing from turning "00123" into 123.
  const workbook = XLSX.read(buffer, { type: 'buffer', raw: true });
  const sheetName = workbook.SheetNames[0];
  const sheet = sheetName ? workbook.Sheets[sheetName] : null;
  if (!sheet || !sheet['!ref']) return { sheetName, headers: [], rows: [] };

  const firstRow = XLSX.utils.decode_range(sheet['!ref']).s.r;
  const grid = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '', blankrows: true });
  const isBlank = (cells) => cells.every((c) => String(c).trim() === '');

  const headerIndex = grid.findIndex((cells) => !isBlank(cells));
  if (headerIndex === -1) return { sheetName, headers: [], rows: [] };

  const width = Math.max(...grid.map((cells) => cells.length));
  const rawHeaders = Array.from({ length: width }, (_, i) => grid[headerIndex][i]);
  const headers = uniqueHeaders(rawHeaders);

  const rows = [];
  for (let i = headerIndex + 1; i < grid.length; i++) {
    const cells = grid[i];
    if (isBlank(cells)) continue;
    const values = {};
    headers.forEach((header, c) => {
      values[header] = String(cells[c] ?? '').trim();
    });
    rows.push({ rowNumber: firstRow + i + 1, values });
  }
  return { sheetName, headers, rows };
}

/** Reads only the header row, for the column picker in Settings. */
function readHeaders(filePath) {
  return readTable(filePath).headers;
}

const EXCEL_EPOCH = Date.UTC(1899, 11, 30);

function dateSerial(year, month, day) {
  return (Date.UTC(year, month - 1, day) - EXCEL_EPOCH) / 86400000;
}

/**
 * Turns display text back into an Excel cell. Only unambiguous shapes are
 * converted, and each is given a number format that displays it exactly as
 * it was read, so reading the file back yields the same text.
 */
function toCell(text) {
  const s = String(text ?? '');
  if (s === '') return null;
  let m;

  if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)) && +m[1] <= 12 && +m[2] <= 31) {
    return { t: 'n', v: dateSerial(+m[3], +m[1], +m[2]), z: 'm/d/yyyy' };
  }
  if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/)) && +m[2] >= 1 && +m[2] <= 12 && +m[3] >= 1 && +m[3] <= 31) {
    return { t: 'n', v: dateSerial(+m[1], +m[2], +m[3]), z: 'yyyy-mm-dd' };
  }
  if ((m = s.match(/^(-)?\$(\d{1,3}(?:,\d{3})*|\d+)\.(\d{2})$/))) {
    const value = Number(`${m[2].replace(/,/g, '')}.${m[3]}`);
    if (m[2].replace(/,/g, '').length <= 12) {
      return { t: 'n', v: m[1] ? -value : value, z: '"$"#,##0.00' };
    }
  }
  // Plain numbers without leading zeros, short enough that Excel's General
  // format shows every digit.
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(s) && s.replace(/\D/g, '').length <= 10 && !/\.\d*0$/.test(s)) {
    return { t: 'n', v: Number(s) };
  }
  return { t: 's', v: s };
}

/**
 * Writes rows (objects keyed by header) to a single-sheet workbook. The file
 * is written beside the target and then renamed over it, so an interrupted
 * write never leaves a half-written spreadsheet.
 */
function writeTable(filePath, { sheetName, headers, rows }) {
  const sheet = {};
  headers.forEach((header, c) => {
    sheet[XLSX.utils.encode_cell({ r: 0, c })] = { t: 's', v: header };
  });
  rows.forEach((row, r) => {
    headers.forEach((header, c) => {
      const cell = toCell(row[header]);
      if (cell) sheet[XLSX.utils.encode_cell({ r: r + 1, c })] = cell;
    });
  });
  const lastCol = Math.max(headers.length - 1, 0);
  const ref = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows.length, c: lastCol } });
  sheet['!ref'] = ref;
  if (headers.length) sheet['!autofilter'] = { ref };
  sheet['!cols'] = headers.map((header) => {
    let longest = header.length;
    for (const row of rows) longest = Math.max(longest, String(row[header] ?? '').length);
    return { wch: Math.min(Math.max(longest + 2, 8), 50) };
  });

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, sheetName || 'Sheet1');
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx', compression: true });

  const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.tmp`);
  fs.writeFileSync(tempPath, buffer);
  try {
    fs.renameSync(tempPath, filePath);
  } catch (err) {
    fs.rmSync(tempPath, { force: true });
    throw err;
  }
}

module.exports = { SPREADSHEET_EXTENSIONS, isSpreadsheet, readTable, readHeaders, writeTable, toCell };
