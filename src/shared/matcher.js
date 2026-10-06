'use strict';

// Value normalization and the duplicate-matching index. Pure functions only,
// so this module can be tested without Electron or the file system. It is
// also loaded by the review screen (as a plain script, exposing
// window.Matcher) so cells are highlighted by the same rules used to match.

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

function pad2(n) {
  return String(n).padStart(2, '0');
}

function toIsoDate(year, month, day) {
  if (year < 100) year += year < 30 ? 2000 : 1900; // Excel's two-digit-year rule
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function monthNumber(word) {
  return MONTHS[word.slice(0, 3).toLowerCase()] || null;
}

/**
 * Recognizes the date layouts Excel and CSV exports commonly produce
 * (3/15/2023, 03-15-23, 2023-03-15, 15-Mar-2023, March 15, 2023) and
 * returns yyyy-mm-dd, or null when the text is not a date. Month-first
 * order is assumed for numeric dates. A trailing time of day is ignored.
 */
function parseDate(text) {
  const s = String(text)
    .trim()
    .replace(/(?:T|\s+)\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?\s*(?:am|pm)?\s*(?:z|[+-]\d{2}:?\d{2})?$/i, '');
  let m;
  if ((m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/))) {
    return toIsoDate(+m[1], +m[2], +m[3]);
  }
  if ((m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})$/))) {
    return toIsoDate(+m[3], +m[1], +m[2]);
  }
  if ((m = s.match(/^(\d{1,2})[-\s]([a-z]{3,9})\.?[-\s,]+(\d{4}|\d{2})$/i))) {
    const month = monthNumber(m[2]);
    return month ? toIsoDate(+m[3], month, +m[1]) : null;
  }
  if ((m = s.match(/^([a-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4}|\d{2})$/i))) {
    const month = monthNumber(m[1]);
    return month ? toIsoDate(+m[3], month, +m[2]) : null;
  }
  return null;
}

/**
 * Reduces a numeric-looking value ("$1,234.50", "(12.00)", "00123", "7%")
 * to a canonical string ("1234.5", "-12", "123", "7%"), or returns null.
 * Works on the digits as text so long IDs never lose precision.
 */
function parseNumber(text) {
  let s = String(text).replace(/\s+/g, '');
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (s.startsWith('-')) {
    negative = !negative;
    s = s.slice(1);
  }
  const hadCurrency = /^[$€£]/.test(s);
  if (hadCurrency) s = s.slice(1);
  if (s.startsWith('-')) {
    negative = !negative;
    s = s.slice(1);
  }
  if (hadCurrency && /^-*$/.test(s)) return '0'; // accounting format shows zero as "$ -"
  let percent = false;
  if (s.endsWith('%')) {
    percent = true;
    s = s.slice(0, -1);
  }
  if (!/^(?:\d{1,3}(?:,\d{3})+|\d+)?(?:\.\d+)?$/.test(s) || !/\d/.test(s)) return null;

  let [int, frac = ''] = s.replace(/,/g, '').split('.');
  int = int.replace(/^0+(?=\d)/, '') || '0';
  frac = frac.replace(/0+$/, '');
  let out = frac ? `${int}.${frac}` : int;
  if (negative && /[1-9]/.test(out)) out = `-${out}`;
  return percent ? `${out}%` : out;
}

/**
 * The comparison key for a cell. Empty cells return '' and never match.
 * Text is compared case- and spacing-insensitively; dates and numbers are
 * compared by value so "3/15/2023" equals "2023-03-15" and "$1,234.50"
 * equals "1234.5".
 */
function normalizeValue(value) {
  if (value === null || value === undefined) return '';
  const text = String(value).replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return parseDate(text) ?? parseNumber(text) ?? text.toLowerCase();
}

function normalizeHeader(header) {
  return String(header ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Finds the header in `headers` that names the same column as `name`. */
function resolveHeader(headers, name) {
  const wanted = normalizeHeader(name);
  return headers.find((h) => normalizeHeader(h) === wanted) ?? null;
}

/** Maps each match field to the sheet's header for it, or null if absent. */
function resolveFields(headers, fields) {
  return fields.map((field) => resolveHeader(headers, field));
}

/** Pulls the match-field values out of a record, using resolveFields() output. */
function pickValues(record, resolvedFields) {
  return resolvedFields.map((header) => (header ? record[header] ?? '' : ''));
}

/**
 * An index over the match fields of known records. For each field it maps
 * a normalized value to the records holding it, so finding the records that
 * match a new row only touches records that share at least one value with it.
 */
class MatchIndex {
  constructor(fieldCount) {
    this.byField = Array.from({ length: fieldCount }, () => new Map());
    this.entries = [];
  }

  add(entry, fieldValues) {
    const id = this.entries.push(entry) - 1;
    fieldValues.forEach((value, f) => {
      const key = normalizeValue(value);
      if (!key) return;
      const ids = this.byField[f].get(key);
      if (ids) ids.push(id);
      else this.byField[f].set(key, [id]);
    });
  }

  /**
   * Returns [{ entry, fields: [fieldIndex, ...] }] for every known record
   * that matches on all of the first `required` fields and on at least
   * `atLeast` of the fields after them, best matches first.
   */
  find(fieldValues, atLeast, required = 0) {
    const hits = new Map();
    fieldValues.forEach((value, f) => {
      const key = normalizeValue(value);
      if (!key) return;
      for (const id of this.byField[f].get(key) ?? []) {
        const fields = hits.get(id);
        if (fields) fields.push(f);
        else hits.set(id, [f]);
      }
    });
    const matches = [];
    for (const [id, fields] of hits) {
      const requiredHits = fields.filter((f) => f < required).length;
      if (requiredHits === required && fields.length - requiredHits >= atLeast) {
        matches.push({ entry: this.entries[id], fields });
      }
    }
    return matches.sort((a, b) => b.fields.length - a.fields.length);
  }
}

const Matcher = {
  parseDate,
  parseNumber,
  normalizeValue,
  normalizeHeader,
  resolveHeader,
  resolveFields,
  pickValues,
  MatchIndex,
};

if (typeof module === 'object' && module.exports) module.exports = Matcher;
else globalThis.Matcher = Matcher;
