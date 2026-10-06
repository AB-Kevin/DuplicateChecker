'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateSettings, defaultSettings } = require('../src/main/settings');

const defaults = defaultSettings('C:/Users/test/Documents');

test('a column checked in both lists stays only in the must-match list', () => {
  const { settings, errors } = validateSettings({
    requiredFields: ['PatientName', 'Member ID'],
    fields: ['patientname', 'CPT Code', 'Service Date'],
    threshold: 2,
  }, defaults);
  assert.deepEqual(errors, {});
  assert.deepEqual(settings.requiredFields, ['PatientName', 'Member ID']);
  assert.deepEqual(settings.fields, ['CPT Code', 'Service Date']);
});

test('the count is checked against the some-must-match list only', () => {
  const tooMany = validateSettings({ requiredFields: ['A', 'B'], fields: ['C', 'D'], threshold: 3 }, defaults);
  assert.match(tooMany.errors.threshold, /more than the 2 columns/);

  const noneNeeded = validateSettings({ requiredFields: ['A'], fields: [], threshold: NaN }, defaults);
  assert.deepEqual(noneNeeded.errors, {});
  assert.equal(noneNeeded.settings.threshold, defaults.threshold);
});

test('the theme follows Windows unless light or dark is chosen', () => {
  assert.equal(validateSettings({}, defaults).settings.theme, 'system');
  assert.equal(validateSettings({ theme: 'dark' }, defaults).settings.theme, 'dark');
  assert.equal(validateSettings({ theme: 'purple' }, defaults).settings.theme, 'system');
});

test('settings saved before must-match columns existed still load', () => {
  const { settings, errors } = validateSettings({ inboxDir: 'C:/In', dataDir: 'C:/Data', fields: ['A', 'B', 'C'], threshold: 2 }, defaults);
  assert.deepEqual(errors, {});
  assert.deepEqual(settings.requiredFields, []);
});
