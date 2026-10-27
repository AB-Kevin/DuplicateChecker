'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const abApps = require('../src/main/abapps');

test('who is signed in to AB Apps is read from its identity file, and anything odd counts as signed out', () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dupcheck-identity-'));
  process.env.AB_APPS_PROFILE = profile;
  try {
    assert.equal(abApps.readIdentity('unused'), null, 'no file');
    const write = (identity) => fs.writeFileSync(abApps.identityPath('unused'), JSON.stringify(identity));
    const good = { version: 1, personId: '0dbc309a-4814-4490-a9ca-0691c9092199', name: '  Mary   Manager ', class: 'manager', dataDir: 'D:\AB Apps' };
    write(good);
    assert.deepEqual(abApps.readIdentity('unused'), { personId: good.personId, name: 'Mary Manager', class: 'manager' });
    write({ ...good, version: 2 });
    assert.equal(abApps.readIdentity('unused'), null, 'a version it doesn\'t know');
    write({ ...good, class: 'admin' });
    assert.equal(abApps.readIdentity('unused'), null, 'an unknown class');
    fs.writeFileSync(abApps.identityPath('unused'), '{ "version": 1, ');
    assert.equal(abApps.readIdentity('unused'), null, 'half written');
  } finally {
    delete process.env.AB_APPS_PROFILE;
  }
});

test('only the host changes the matching settings, and while someone is signed in to AB Apps, only a manager', () => {
  const as = (cls) => ({ personId: '0dbc309a-4814-4490-a9ca-0691c9092199', name: 'X', class: cls });
  assert.equal(abApps.canManage(true, null), true, 'the host, without AB Apps');
  assert.equal(abApps.canManage(true, as('manager')), true);
  assert.equal(abApps.canManage(true, as('employee')), false);
  assert.equal(abApps.canManage(true, as('contractor')), false);
  assert.equal(abApps.canManage(false, as('manager')), false, 'a manager who is reviewing');
});
