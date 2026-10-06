'use strict';

// Several people can use one data folder at the same time, for example
// through OneDrive. OneDrive can't merge two people's changes to the same
// file, so every file has exactly one writer:
//
//   App data/people/<id>.json  written only by that person's copy of the app:
//                              who they are, whether they are the host, which
//                              entry they have open, and their decisions.
//   everything else            written only by the host, which imports files
//                              from the inbox and saves everyone's sent
//                              decisions to the spreadsheets.
//
// Changes reach the other computers as fast as OneDrive syncs them.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const chokidar = require('chokidar');
const { readJson, writeJson } = require('./jsonfile');
const { APP_DATA, statePath, sharedSettingsPath } = require('./datafolder');
const { applyDecisions } = require('./processor');

const ACTIVE_MS = 5 * 60 * 1000; // someone not heard from for this long has left
const MAX_RESOLVED = 500; // saved decisions remembered so whoever made them can be told
const HEARTBEAT_MS = 60 * 1000;
const TICK_MS = 30 * 1000;
// OneDrive names conflict copies "<name>-<COMPUTER>.json"; those don't match and are ignored.
const PERSON_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/i;

const peopleDir = (dataDir) => path.join(dataDir, APP_DATA, 'people');
const personPath = (dataDir, id) => path.join(peopleDir(dataDir), `${id}.json`);

function readPeople(dataDir) {
  let names;
  try {
    names = fs.readdirSync(peopleDir(dataDir));
  } catch {
    return [];
  }
  return names
    .filter((name) => PERSON_FILE.test(name))
    .map((name) => readJson(path.join(peopleDir(dataDir), name), null))
    .filter((person) => person && person.id);
}

function isActive(person, now = Date.now()) {
  return person.open !== false && now - Date.parse(person.seen) < ACTIVE_MS;
}

/**
 * The active computers set as host, longest-serving first. Only the first
 * acts as host; any others wait, so two computers never import or save at once.
 */
function activeHosts(people, now = Date.now()) {
  return people
    .filter((p) => p.role === 'host' && isActive(p, now))
    .sort((a, b) => String(a.hostSince).localeCompare(String(b.hostSince)) || a.id.localeCompare(b.id));
}

/** For each entry still waiting for review, the first decision anyone sent for it. */
function firstSentDecisions(people, queue) {
  const waiting = new Set(queue.map((item) => item.id));
  const first = new Map();
  for (const person of people) {
    for (const [id, mine] of Object.entries(person.decisions ?? {})) {
      if (!mine.sent || !waiting.has(id)) continue;
      const best = first.get(id);
      if (!best || mine.sent < best.sent || (mine.sent === best.sent && person.id < best.personId)) {
        first.set(id, { decision: mine.decision, sent: mine.sent, personId: person.id, name: person.name });
      }
    }
  }
  return first;
}

function describeSaveError(err) {
  return err.name === 'FileLockedError'
    ? `${err.fileName} is open in another program (usually Excel) on the host computer. Sent decisions are kept and will be saved automatically once it is closed.`
    : `Decisions could not be saved: ${err.message}`;
}

/**
 * The host's job: saves every sent decision to the spreadsheets, the first
 * one sent winning for each entry. Each saved decision is recorded in
 * `state.resolved` so whoever made it can be told, and a failure is recorded
 * in `state.applyError` for everyone to see. `ctx` is what applyDecisions
 * takes. Returns its counts plus the ids of the people whose decisions were
 * saved, or null if nothing was waiting.
 */
function saveSentDecisions(ctx, people, now = new Date()) {
  const { state } = ctx;
  const first = firstSentDecisions(people, state.queue);
  if (!first.size) {
    if (state.applyError) {
      state.applyError = null;
      ctx.saveState();
    }
    return null;
  }
  const at = now.toISOString();
  const items = new Map(state.queue.map((item) => [item.id, item]));
  for (const item of state.queue) item.decision = first.get(item.id)?.decision ?? null;
  try {
    const result = applyDecisions({ ...ctx, now });
    state.applyError = null;
    return { ...result, people: [...new Set([...first.values()].map((d) => d.personId))] };
  } catch (err) {
    state.applyError = { message: describeSaveError(err), at };
    throw new Error(state.applyError.message);
  } finally {
    // Record whatever left the queue, even if only part of the save worked.
    const waiting = new Set(state.queue.map((item) => item.id));
    state.resolved ??= [];
    for (const [id, d] of first) {
      if (waiting.has(id)) continue;
      const { fileName, rowNumber } = items.get(id);
      state.resolved.unshift({ id, decision: d.decision, personId: d.personId, name: d.name, at, fileName, rowNumber });
    }
    state.resolved.length = Math.min(state.resolved.length, MAX_RESOLVED);
    for (const item of state.queue) delete item.decision;
    ctx.saveState();
  }
}

/**
 * Drops `me`'s decisions on entries that are no longer waiting for review.
 * Returns which of them were saved as `me` decided (`saved`), which were
 * decided differently by someone else first (`overruled`), and whether
 * anything changed.
 */
function settleDecisions(me, state) {
  const waiting = new Set(state.queue.map((item) => item.id));
  const resolved = new Map((state.resolved ?? []).map((r) => [r.id, r]));
  const saved = [];
  const overruled = [];
  let changed = false;
  for (const [id, mine] of Object.entries(me.decisions)) {
    if (waiting.has(id)) continue;
    const outcome = resolved.get(id);
    if (outcome?.personId === me.id) saved.push(outcome);
    else if (outcome && outcome.decision !== mine.decision) overruled.push(outcome);
    delete me.decisions[id];
    changed = true;
  }
  if (me.viewing && !waiting.has(me.viewing)) {
    me.viewing = null;
    changed = true;
  }
  return { changed, saved, overruled };
}

/**
 * Adds to each entry what this person and everyone else has done with it:
 * `decision` and `sent` (this person's), `others` (everyone else's
 * decisions), `lockedBy` (who sent a decision first, if not this person) and
 * `viewers` (who else has it open).
 */
function annotateQueue(queue, me, people, now = Date.now()) {
  const others = people.filter((p) => p.id !== me.id);
  return queue.map((item) => {
    const mine = me.decisions[item.id];
    const theirs = others
      .filter((p) => p.decisions?.[item.id])
      .map((p) => ({ name: p.name, decision: p.decisions[item.id].decision, sent: p.decisions[item.id].sent ?? null }));
    const firstSent = theirs.filter((d) => d.sent).sort((a, b) => a.sent.localeCompare(b.sent))[0];
    return {
      ...item,
      decision: mine?.decision ?? null,
      sent: Boolean(mine?.sent),
      others: theirs.map((d) => ({ name: d.name, decision: d.decision, sent: Boolean(d.sent) })),
      lockedBy: !mine?.sent && firstSent ? firstSent.name : null,
      viewers: others.filter((p) => p.viewing === item.id && isActive(p, now)).map((p) => p.name),
    };
  });
}

/**
 * This copy of the app's place in a data folder: keeps its own person file
 * up to date and reports changes other people make. Emits 'people' when
 * someone's file changes, 'state-file' when the host's review queue changes,
 * 'settings-file' when the shared settings change, and 'tick' periodically.
 */
class Team extends EventEmitter {
  constructor(identity) {
    super();
    this.identity = identity; // { id, name }
    this.dataDir = null;
    this.me = null;
    this.others = [];
    this.watcher = null;
    this.timer = null;
    this.pending = new Map(); // debounced events and writes
    this.mtimes = {};
  }

  open(dataDir, { isHost, hostSince }) {
    this.close();
    this.dataDir = dataDir;
    const saved = readJson(personPath(dataDir, this.identity.id), {});
    this.me = {
      id: this.identity.id,
      name: this.identity.name,
      computer: os.hostname(),
      role: isHost ? 'host' : 'reviewer',
      hostSince: isHost ? hostSince : null,
      open: true,
      seen: null,
      viewing: null,
      decisions: saved.decisions ?? {}, // { [itemId]: { decision, at, sent } }; sent is a time or null
    };
    this.write();
    this.refresh();
    this.mtimes = { state: this.mtime(statePath(dataDir)), settings: this.mtime(sharedSettingsPath(dataDir)) };

    this.watcher = chokidar.watch(path.join(dataDir, APP_DATA), {
      depth: 1,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 400, pollInterval: 100 },
    });
    this.watcher.on('all', (_event, file) => this.onFileChange(file));
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  /** Marks this person as gone and stops watching. */
  close() {
    if (!this.dataDir) return;
    clearInterval(this.timer);
    for (const timer of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
    if (this.watcher) this.watcher.close();
    this.me.open = false;
    this.me.viewing = null;
    try {
      this.write();
    } catch {
      // The data folder may be unavailable; others see this person leave after ACTIVE_MS.
    }
    this.dataDir = null;
  }

  write() {
    this.me.seen = new Date().toISOString();
    writeJson(personPath(this.dataDir, this.me.id), this.me);
  }

  later(key, ms, fn) {
    clearTimeout(this.pending.get(key));
    this.pending.set(key, setTimeout(() => {
      this.pending.delete(key);
      fn();
    }, ms));
  }

  /** Everyone using the folder, this person first. */
  people() {
    return this.me ? [this.me, ...this.others] : [];
  }

  refresh() {
    this.others = readPeople(this.dataDir).filter((p) => p.id !== this.me.id);
  }

  mtime(file) {
    try {
      return fs.statSync(file).mtimeMs;
    } catch {
      return null;
    }
  }

  onFileChange(file) {
    if (!this.dataDir) return;
    if (path.basename(path.dirname(file)) === 'people') {
      this.later('people', 300, () => {
        this.refresh();
        this.emit('people');
      });
    } else if (path.basename(file) === 'review-state.json') {
      this.mtimes.state = this.mtime(file);
      this.later('state', 300, () => this.emit('state-file'));
    } else if (path.basename(file) === 'settings.json') {
      this.mtimes.settings = this.mtime(file);
      this.later('settings', 300, () => this.emit('settings-file'));
    }
  }

  /** Heartbeat, plus a fallback for file-change notifications OneDrive doesn't deliver. */
  tick() {
    if (!this.dataDir) return;
    try {
      if (Date.now() - Date.parse(this.me.seen) >= HEARTBEAT_MS) this.write();
    } catch {
      // Data folder unavailable for now; try again next tick.
    }
    this.refresh();
    this.emit('people');
    for (const [key, file, event] of [
      ['state', statePath(this.dataDir), 'state-file'],
      ['settings', sharedSettingsPath(this.dataDir), 'settings-file'],
    ]) {
      const mtime = this.mtime(file);
      if (mtime !== this.mtimes[key]) {
        this.mtimes[key] = mtime;
        this.emit(event);
      }
    }
    this.emit('tick');
  }

  setRole(isHost, hostSince) {
    this.me.role = isHost ? 'host' : 'reviewer';
    this.me.hostSince = isHost ? hostSince : null;
    this.write();
  }

  setName(name) {
    this.identity.name = name;
    this.me.name = name;
    this.write();
  }

  /** Records which entry this person has open; written after a pause so browsing stays quiet. */
  setViewing(itemId) {
    if (this.me.viewing === itemId) return;
    this.me.viewing = itemId;
    this.later('viewing', 1000, () => this.write());
  }

  /** Records draft decisions. Decisions already sent can't be changed. */
  decide(ids, decision) {
    const at = new Date().toISOString();
    for (const id of ids) {
      if (this.me.decisions[id]?.sent) continue;
      if (decision) this.me.decisions[id] = { decision, at, sent: null };
      else delete this.me.decisions[id];
    }
    this.write();
  }

  /** Sends every draft decision except those on `skipIds`. Returns how many were sent. */
  send(skipIds = new Set()) {
    const sent = new Date().toISOString();
    let n = 0;
    for (const [id, mine] of Object.entries(this.me.decisions)) {
      if (mine.sent || skipIds.has(id)) continue;
      mine.sent = sent;
      n++;
    }
    if (n) this.write();
    return n;
  }
}

module.exports = {
  ACTIVE_MS,
  peopleDir,
  personPath,
  readPeople,
  isActive,
  activeHosts,
  firstSentDecisions,
  saveSentDecisions,
  settleDecisions,
  annotateQueue,
  Team,
};
