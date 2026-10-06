'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

/** Calls the main process and unwraps { ok, value, error }. */
async function call(channel, ...args) {
  const result = await ipcRenderer.invoke(channel, ...args);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

contextBridge.exposeInMainWorld('api', {
  getState: () => call('state:get'),
  saveSettings: (settings) => call('settings:save', settings),
  chooseFolder: (current) => call('dialog:folder', current),
  readColumnsFromFile: () => call('dialog:columns'),
  decide: (ids, decision) => call('review:decide', ids, decision),
  applyDecisions: () => call('review:apply'),
  clearAllData: (phrase) => call('data:clear', phrase),
  rescanInbox: () => call('inbox:rescan'),
  chooseFilesForInbox: () => call('inbox:choose'),
  addFilesToInbox: (files) => call('inbox:add', Array.from(files, (file) => webUtils.getPathForFile(file))),
  open: (target) => call('open', target),
  onStateChanged: (callback) => ipcRenderer.on('state-changed', () => callback()),
  onNotice: (callback) => ipcRenderer.on('notice', (_event, notice) => callback(notice)),
});
