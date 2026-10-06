'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseDate, parseNumber, normalizeValue, resolveFields, pickValues, MatchIndex } = require('../src/shared/matcher');

test('dates in common layouts normalize to the same value', () => {
  for (const text of ['3/15/2023', '03/15/2023', '3/15/23', '2023-03-15', '2023/3/15', '15-Mar-2023', 'March 15, 2023', '3/15/2023 0:00', '2023-03-15T00:00:00Z']) {
    assert.equal(parseDate(text), '2023-03-15', text);
  }
  assert.equal(parseDate('13/45/2023'), null);
  assert.equal(parseDate('45000'), null);
  assert.equal(parseDate('hello'), null);
});

test('amounts and IDs normalize by value', () => {
  assert.equal(parseNumber('$1,234.50'), '1234.5');
  assert.equal(parseNumber('1234.5'), '1234.5');
  assert.equal(parseNumber(' $ 1,234.50 '), '1234.5');
  assert.equal(parseNumber('($12.00)'), '-12');
  assert.equal(parseNumber('-$12'), '-12');
  assert.equal(parseNumber('$ -   '), '0');
  assert.equal(parseNumber('00123'), '123');
  assert.equal(parseNumber('7%'), '7%');
  assert.equal(parseNumber('123456789012345678901'), '123456789012345678901');
  assert.equal(parseNumber('1,2'), null);
  assert.equal(parseNumber('INV-001'), null);
});

test('text compares ignoring case and spacing; blanks never match', () => {
  assert.equal(normalizeValue('  John   SMITH '), 'john smith');
  assert.equal(normalizeValue(''), '');
  assert.equal(normalizeValue(null), '');
});

test('columns are found regardless of case and spacing', () => {
  const headers = ['Member ID', 'PatientName', 'Service Date'];
  const resolved = resolveFields(headers, ['member id', 'PATIENTNAME', 'Charge Amount']);
  assert.deepEqual(resolved, ['Member ID', 'PatientName', null]);
  assert.deepEqual(pickValues({ 'Member ID': '1', PatientName: 'Ann' }, resolved), ['1', 'Ann', '']);
});

test('index returns records matching at least the threshold', () => {
  const index = new MatchIndex(4);
  index.add('a', ['100', 'Ann Lee', '3/15/2023', '$50.00']);
  index.add('b', ['100', 'Ann Lee', '3/16/2023', '$75.00']);
  index.add('c', ['200', 'Bob Ray', '3/15/2023', '$50.00']);

  const three = index.find(['100', 'ann lee', '2023-03-15', '99'], 3);
  assert.deepEqual(three.map((m) => m.entry), ['a']);
  assert.deepEqual(three[0].fields, [0, 1, 2]);

  const two = index.find(['100', 'ann lee', '2023-03-15', '99'], 2);
  assert.deepEqual(two.map((m) => m.entry).sort(), ['a', 'b']);

  // Shared blanks don't count as matches.
  index.add('d', ['', '', '', '$1.00']);
  assert.deepEqual(index.find(['', '', '', '1'], 1).map((m) => m.entry), ['d']);
  assert.deepEqual(index.find(['', '', '', ''], 1), []);
});
