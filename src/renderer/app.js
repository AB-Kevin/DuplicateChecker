'use strict';

(() => {
  const api = window.api;
  const { normalizeValue, normalizeHeader, resolveHeader } = window.Matcher;

  const ui = {
    data: null, // snapshot from the main process
    view: null,
    selectedId: null,
    draft: null, // settings being edited
    draftDirty: false,
    extraColumns: [], // column names read from a spreadsheet in Settings
    errors: {},
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

  const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);

  const count = (n, one, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
  const formatWhen = (iso) => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  const formatDay = (iso) => new Date(iso).toLocaleDateString([], { dateStyle: 'medium' });
  const basename = (p) => String(p).split(/[\\/]/).filter(Boolean).pop() ?? p;
  const listText = (items) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

  // Toasts ---------------------------------------------------------------

  function toast(message, kind = 'info') {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.innerHTML = `<p>${kind === 'error' ? '<strong>Needs attention</strong>' : ''}${esc(message)}</p>
      <button class="toast-close" aria-label="Dismiss"></button>`;
    const remove = () => {
      el.classList.add('leaving');
      setTimeout(() => el.remove(), 200);
    };
    el.querySelector('.toast-close').addEventListener('click', remove);
    $('#toasts').append(el);
    setTimeout(remove, kind === 'error' ? 20000 : 7000);
    const all = $$('.toast');
    if (all.length > 4) all[0].remove();
  }

  /** Removes warnings an action has since resolved, e.g. "file is open" once a retry works. */
  function clearErrorToasts() {
    $$('.toast.error').forEach((el) => el.remove());
  }

  /** Runs an API call, showing any error as a toast. Resolves to undefined on failure. */
  async function attempt(fn) {
    try {
      return await fn();
    } catch (err) {
      toast(err.message, 'error');
      return undefined;
    }
  }

  // Data -----------------------------------------------------------------

  async function refresh() {
    const data = await attempt(() => api.getState());
    if (!data) return;
    const first = !ui.data;
    ui.data = data;
    if (!ui.draftDirty) loadDraft();
    if (first) showView(hasColumns(data.settings) ? 'review' : 'settings');
    else render();
  }

  let refreshTimer = null;
  api.onStateChanged(() => {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refresh, 50);
  });
  api.onNotice(({ kind, message }) => toast(message, kind));

  function render() {
    renderHeader();
    if (ui.view === 'review') renderReview();
    if (ui.view === 'activity') renderActivity();
    if (ui.view === 'settings') {
      renderSharing();
      renderColumns();
    }
  }

  function showView(view) {
    ui.view = view;
    for (const name of ['review', 'activity', 'settings']) $(`#view-${name}`).hidden = name !== view;
    $$('.tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.view === view));
    render();
    reportViewing();
  }

  // Header ---------------------------------------------------------------

  const isHost = () => ui.data.team.role === 'host';
  const hostName = () => ui.data.team.host?.name;

  function renderHeader() {
    const { watcher, settings, queue, team } = ui.data;
    let stateClass;
    let text;
    if (team.role === 'host') {
      stateClass = watcher.state;
      text = {
        watching: `Host · watching ${basename(settings.inboxDir)}`,
        error: 'Host · inbox unavailable',
        stopped: 'Host · not watching the inbox',
      }[watcher.state];
    } else if (team.role === 'waiting-host') {
      stateClass = 'error';
      text = 'Host on hold';
    } else {
      stateClass = team.host ? 'watching' : 'stopped';
      text = team.host ? `Reviewing · ${team.host.name} is host` : 'Reviewing · no host running';
    }
    const others = team.people.filter((p) => !p.isMe).map((p) => p.name);
    if (others.length) text += ` · ${count(others.length, 'other person', 'other people')} here`;
    const status = $('#watch-status');
    status.className = `watch-status ${stateClass}`;
    status.innerHTML = `<span>${esc(text)}</span>`;
    status.title = [watcher.message || settings.inboxDir, others.length ? `Also here: ${listText(others)}` : '']
      .filter(Boolean).join('\n');

    const open = queue.filter(isOpenForMe).length;
    const badge = $('#review-count');
    badge.hidden = !open;
    badge.textContent = open.toLocaleString();
    $('#settings-dirty-dot').hidden = !ui.draftDirty;
    renderBanner();
  }

  /** Problems with sharing the data folder that everyone should see. */
  function renderBanner() {
    const { team, queue } = ui.data;
    const lines = [];
    if (team.role === 'waiting-host') {
      lines.push(`This computer is set as the host, but ${team.host?.name ?? 'another computer'}'s computer already is. Only one host works at a time, so this computer is reviewing until that app closes. To stop being the host, turn it off under Settings, Sharing.`);
    } else if (team.role === 'host' && team.otherHosts.length) {
      lines.push(`${listText(team.otherHosts)} ${team.otherHosts.length === 1 ? 'is' : 'are'} also set as the host. This computer is acting as host; the others are waiting.`);
    }
    if (team.applyError) lines.push(team.applyError.message);
    if (team.role === 'reviewer' && !team.host && queue.length) {
      lines.push('The host computer\'s app isn\'t open. You can keep reviewing; decisions you send are kept and will be saved when the host\'s app is open.');
    }
    $('#banner').hidden = !lines.length;
    $('#banner').innerHTML = lines.map((line) => `<p>${esc(line)}</p>`).join('');
  }

  // Review ---------------------------------------------------------------

  const KIND_LABELS = { database: 'Database', batch: 'Same file', queue: 'Awaiting review' };

  function matchDetail(match) {
    if (match.kind === 'database') {
      return [match.sourceFile, match.sourceRow && `row ${match.sourceRow}`, match.dateAdded && `added ${match.dateAdded}`]
        .filter(Boolean).join(' · ');
    }
    if (match.kind === 'batch') return `Row ${match.sourceRow}`;
    return `${match.sourceFile} · row ${match.sourceRow}`;
  }

  function matchPhrase(match) {
    if (match.kind === 'database') return `an entry in the database${match.sourceFile ? ` from ${match.sourceFile}` : ''}`;
    if (match.kind === 'batch') return `row ${match.sourceRow} of the same file`;
    return `row ${match.sourceRow} of ${match.sourceFile}, which is also awaiting review`;
  }

  function valueIn(headers, record, column) {
    const header = resolveHeader(headers, column);
    return header ? record[header] ?? '' : '';
  }

  const hasColumns = (settings) => Boolean(settings.fields.length || settings.requiredFields?.length);

  /** The columns an item was compared on: must-match columns first. Older items have no requiredFields. */
  const itemColumns = (item) => [...(item.requiredFields ?? []), ...item.fields];

  function itemSummary(item) {
    const values = itemColumns(item).map((f) => valueIn(item.headers, item.record, f)).filter(Boolean);
    return values.join(' · ') || 'Compared columns are blank';
  }

  // Each entry, as this person sees it, is one of: open (nobody has settled
  // it and this person hasn't decided), a draft (decided, not sent yet), sent
  // (waiting for the host to save it), or taken (someone else sent first).
  const isOpenForMe = (item) => !item.decision && !item.lockedBy;
  const isDraft = (item) => Boolean(item.decision) && !item.sent && !item.lockedBy;
  const isSettled = (item) => item.sent || Boolean(item.lockedBy);
  const decisionText = (decision) => (decision === 'duplicate' ? 'a duplicate' : 'not a duplicate');

  function selectedItem() {
    return ui.data.queue.find((item) => item.id === ui.selectedId) ?? null;
  }

  function ensureSelection() {
    const { queue } = ui.data;
    if (!selectedItem()) ui.selectedId = (queue.find(isOpenForMe) ?? queue[0])?.id ?? null;
  }

  /** Tells the others which entry this person has open. */
  let reportedViewing;
  function reportViewing() {
    const viewing = ui.view === 'review' ? ui.selectedId : null;
    if (viewing === reportedViewing) return;
    reportedViewing = viewing;
    api.setViewing(viewing).catch(() => {});
  }

  function renderReview() {
    const { queue, settings } = ui.data;
    ensureSelection();

    const empty = !queue.length;
    $('#review-panes').hidden = empty;
    $('#apply-bar').hidden = empty;
    $('#review-empty').hidden = !empty;
    if (empty) {
      $('#review-empty').innerHTML = hasColumns(settings)
        ? `<h1>Nothing to review</h1>
           <p>Spreadsheets dropped into the inbox are checked automatically. Entries that look like duplicates will be listed here.</p>
           <p class="path">${esc(settings.inboxDir)}</p>
           <button class="btn btn-secondary" data-open="inbox">Open inbox folder</button>`
        : `<h1>Choose the columns to compare</h1>
           <p>Before spreadsheets can be checked, choose the columns that identify an entry and how many of them must match.</p>
           <button class="btn btn-primary" data-view="settings">Open Settings</button>`;
      return;
    }

    const open = queue.filter(isOpenForMe);
    const drafts = queue.filter(isDraft);
    const settled = queue.filter(isSettled).length;
    const summary = [];
    if (open.length) summary.push(`${count(open.length, 'entry', 'entries')} to review`);
    if (drafts.length) summary.push(`${drafts.length.toLocaleString()} decided`);
    if (settled) summary.push(`${settled.toLocaleString()} waiting for the host`);
    $('#queue-summary').textContent = open.length || drafts.length
      ? summary.join(' · ')
      : `Everything here is decided${settled ? ' and waiting for the host to save it' : ''}.`;
    $('#mark-rest').disabled = !open.length;

    renderQueueList();
    renderDetail(selectedItem());
    reportViewing();

    const dupes = drafts.filter((item) => item.decision === 'duplicate').length;
    const uniques = drafts.length - dupes;
    const host = isHost();
    const apply = $('#apply');
    apply.disabled = !drafts.length;
    apply.textContent = drafts.length
      ? `${host ? 'Save' : 'Send'} ${count(drafts.length, 'decision')}`
      : host ? 'Save decisions' : 'Send decisions';
    apply.title = host ? '' : 'Sends your decisions to the host computer, which saves them to the spreadsheets.';
    const parts = [];
    if (dupes) parts.push(`${count(dupes, 'duplicate')} to Duplicates.xlsx`);
    if (uniques) parts.push(`${count(uniques, 'entry', 'entries')} to Database.xlsx`);
    const waiting = !host && ui.data.team.waitingToSave
      ? ` <span class="muted">${esc(count(ui.data.team.waitingToSave, 'decision'))} sent, waiting for ${esc(hostName() ? `${hostName()}'s computer` : 'the host')} to save.</span>`
      : '';
    $('#apply-summary').innerHTML = drafts.length
      ? `Ready to ${host ? 'save' : 'send'}: ${esc(listText(parts))}.${open.length ? ` <span class="muted">${esc(count(open.length, 'entry', 'entries'))} still to review.</span>` : ''}${waiting}`
      : `<span class="muted">Mark each entry as a duplicate or not, then ${host ? 'save' : 'send'} your decisions.</span>${waiting}`;
  }

  function renderQueueList() {
    const groups = [];
    for (const item of ui.data.queue) {
      const key = `${item.fileName}|${item.importedAt}`;
      if (groups.at(-1)?.key !== key) groups.push({ key, fileName: item.fileName, importedAt: item.importedAt, items: [] });
      groups.at(-1).items.push(item);
    }
    const tag = (item) => {
      if (item.lockedBy) {
        const theirs = item.others.find((o) => o.name === item.lockedBy && o.sent);
        return `<span class="tag tag-gray">${esc(item.lockedBy)}: ${theirs?.decision === 'duplicate' ? 'Duplicate' : 'Not a duplicate'}</span>`;
      }
      const label = { duplicate: 'Duplicate', unique: 'Not a duplicate' }[item.decision];
      if (!label) return '<span></span>';
      const tone = item.sent ? 'tag-gray' : item.decision === 'duplicate' ? 'tag-outline' : 'tag-mint';
      return `<span class="tag ${tone}">${item.sent ? 'Sent · ' : ''}${label}</span>`;
    };
    // Others' unsent decisions and who has the entry open.
    const people = (item) => {
      const notes = item.viewers.map((name) => `${name} has this open`);
      for (const o of item.others) if (!o.sent) notes.push(`${o.name}: ${o.decision === 'duplicate' ? 'duplicate' : 'not a duplicate'}, not sent`);
      return notes.length ? `<span class="qi-people">${esc(notes.join(' · '))}</span>` : '';
    };

    $('#queue-list').innerHTML = groups.map((group) => `
      <div class="queue-group">
        <div class="group-head">
          <strong title="${esc(group.fileName)}">${esc(group.fileName)}</strong>
          <span>${esc(formatDay(group.importedAt))}</span>
        </div>
        ${group.items.map((item) => {
          const best = item.matches[0];
          return `
          <button class="queue-item${item.id === ui.selectedId ? ' selected' : ''}${isOpenForMe(item) ? '' : ' decided'}" data-id="${esc(item.id)}">
            <span class="qi-row">Row ${esc(item.rowNumber)}</span>
            ${tag(item)}
            <span class="qi-summary">${esc(itemSummary(item))}</span>
            <span class="qi-meta">${esc(KIND_LABELS[best.kind])} · ${best.fields.length} of ${itemColumns(item).length} columns match</span>
            ${people(item)}
          </button>`;
        }).join('')}
      </div>`).join('');

    $('.queue-item.selected')?.scrollIntoView({ block: 'nearest' });
  }

  function renderDetail(item) {
    const detail = $('#detail');
    if (!item) {
      detail.innerHTML = '';
      return;
    }
    const best = item.matches[0];
    const required = item.requiredFields ?? [];
    const isRequired = (column) => required.some((r) => normalizeHeader(r) === normalizeHeader(column));
    let lede;
    if (!required.length) {
      lede = `Matches ${matchPhrase(best)} on ${listText(best.fields)}: ${best.fields.length} of ${item.fields.length} compared columns.`;
    } else if (!item.fields.length) {
      lede = `Matches ${matchPhrase(best)} on ${listText(required)}, which must always match.`;
    } else {
      const others = best.fields.filter((f) => !isRequired(f));
      lede = `Matches ${matchPhrase(best)} on ${listText(required)}, which must always match, ` +
        `and on ${others.length} of the ${item.fields.length} other compared columns (${listText(others)}).`;
    }
    if (item.matchCount > 1) {
      lede += ` It also matches ${count(item.matchCount - 1, 'other entry', 'other entries')}`;
      lede += item.matchCount > item.matches.length ? `; the closest ${item.matches.length} are shown.` : '.';
    }

    const columns = [
      { kind: 'This entry', detail: `${item.fileName} · row ${item.rowNumber}`, headers: item.headers, record: item.record },
      ...item.matches.map((m) => ({
        kind: KIND_LABELS[m.kind],
        detail: matchDetail(m),
        headers: m.headers,
        record: m.record,
      })),
    ];

    // Compared columns first, then the entry's other columns, then any
    // columns only the matches have.
    const compared = itemColumns(item).map((f) => resolveHeader(item.headers, f) ?? f);
    const seen = new Set(compared.map(normalizeHeader));
    const others = [];
    for (const header of [item.headers, ...item.matches.map((m) => m.headers)].flat()) {
      const key = normalizeHeader(header);
      if (!seen.has(key)) {
        seen.add(key);
        others.push(header);
      }
    }

    const row = (label, isCompared) => {
      const values = columns.map((col) => valueIn(col.headers, col.record, label));
      const mine = normalizeValue(values[0]);
      const cells = values.map((value, i) => {
        if (!String(value).trim()) return '<td class="blank">&mdash;</td>';
        if (i === 0) return `<td>${esc(value)}</td>`;
        const same = normalizeValue(value) === mine;
        const cls = isCompared ? (same ? 'same' : '') : (same ? 'equal' : 'differs');
        return `<td class="${cls}">${esc(value)}</td>`;
      });
      const mark = isCompared && isRequired(label) ? '<span class="req">Must match</span>' : '';
      return `<tr><th scope="row">${esc(label)}${mark}</th>${cells.join('')}</tr>`;
    };

    // What others are doing with this entry, and why the buttons may be locked.
    const notes = [];
    if (item.lockedBy) {
      const theirs = item.others.find((o) => o.name === item.lockedBy && o.sent);
      notes.push(`${item.lockedBy} has already sent this as ${decisionText(theirs?.decision)}, so it's settled. It leaves the list when the host saves it.`);
    } else if (item.sent) {
      notes.push(`You sent this as ${decisionText(item.decision)}. It leaves the list when ${isHost() ? 'it is saved' : 'the host saves it'}.`);
    }
    for (const o of item.others) {
      if (!o.sent) notes.push(`${o.name} has marked this as ${decisionText(o.decision)} but hasn't sent it yet.`);
    }
    if (item.viewers.length) notes.push(`${listText(item.viewers)} also ${item.viewers.length === 1 ? 'has' : 'have'} this entry open.`);
    const locked = isSettled(item) ? ' disabled' : '';

    detail.innerHTML = `
      <div class="detail-head">
        <div>
          <p class="eyebrow">${esc(item.fileName)} · Row ${esc(item.rowNumber)}</p>
          <h1>Possible duplicate</h1>
          <p class="lede">${esc(lede)}</p>
          ${notes.length ? `<div class="people-note">${notes.map((n) => `<p>${esc(n)}</p>`).join('')}</div>` : ''}
        </div>
        <div class="decision">
          <button class="btn btn-secondary" data-decide="duplicate" aria-pressed="${item.decision === 'duplicate'}"${locked}>Duplicate <kbd>D</kbd></button>
          <button class="btn btn-secondary" data-decide="unique" aria-pressed="${item.decision === 'unique'}"${locked}>Not a duplicate <kbd>N</kbd></button>
        </div>
      </div>
      <div class="compare-wrap">
        <table class="compare">
          <thead>
            <tr>
              <th></th>
              ${columns.map((col) => `<th><span class="col-kind">${esc(col.kind)}</span><span class="col-detail">${esc(col.detail)}</span></th>`).join('')}
            </tr>
          </thead>
          <tbody>
            <tr class="group-row"><th colspan="${columns.length + 1}">Compared columns</th></tr>
            ${compared.map((label) => row(label, true)).join('')}
            ${others.length ? `<tr class="group-row"><th colspan="${columns.length + 1}">Other columns</th></tr>` : ''}
            ${others.map((label) => row(label, false)).join('')}
          </tbody>
        </table>
      </div>
      <p class="compare-legend muted small">
        <span class="swatch"></span>Shaded cells match this entry. In the other columns, values that differ from this entry are in bold.
        Keys: <kbd>D</kbd> duplicate, <kbd>N</kbd> not a duplicate, <kbd>U</kbd> undo, <kbd>&uarr;</kbd> <kbd>&darr;</kbd> move, <kbd>Ctrl</kbd>+<kbd>S</kbd> save.
      </p>`;
  }

  function selectNextOpen(fromId) {
    const { queue } = ui.data;
    const i = queue.findIndex((item) => item.id === fromId);
    const next = queue.slice(i + 1).find(isOpenForMe) ?? queue.slice(0, i).find(isOpenForMe);
    if (next) ui.selectedId = next.id;
  }

  async function decide(decision, { toggle = false } = {}) {
    const item = selectedItem();
    if (!item) return;
    if (isSettled(item)) {
      toast(item.lockedBy ? `${item.lockedBy} has already decided this entry.` : 'You have already sent your decision for this entry.', 'info');
      return;
    }
    const value = toggle && item.decision === decision ? null : decision;
    item.decision = value;
    if (value) selectNextOpen(item.id);
    render();
    await attempt(() => api.decide([item.id], value));
  }

  function move(delta) {
    const { queue } = ui.data;
    const i = queue.findIndex((item) => item.id === ui.selectedId);
    const next = queue[Math.min(Math.max(i + delta, 0), queue.length - 1)];
    if (next && next.id !== ui.selectedId) {
      ui.selectedId = next.id;
      renderReview();
    }
  }

  async function markRestUnique() {
    const rest = ui.data.queue.filter(isOpenForMe);
    if (!rest.length) return;
    const ok = window.confirm(
      `Mark ${count(rest.length, 'remaining entry', 'remaining entries')} as not duplicates?\n\n` +
      `They will be added to the database when you ${isHost() ? 'save' : 'send'} your decisions.`,
    );
    if (!ok) return;
    for (const item of rest) item.decision = 'unique';
    render();
    await attempt(() => api.decide(rest.map((item) => item.id), 'unique'));
  }

  async function saveDecisions() {
    if (!ui.data.queue.some(isDraft)) return;
    $('#apply').disabled = true;
    const result = await attempt(() => api.applyDecisions());
    if (result?.saved) {
      clearErrorToasts();
      const { duplicates, added, expired } = result.saved;
      const parts = [];
      if (duplicates) parts.push(`${count(duplicates, 'entry', 'entries')} added to Duplicates.xlsx`);
      if (added) parts.push(`${count(added, 'entry', 'entries')} added to Database.xlsx`);
      let message = `Saved: ${listText(parts)}.`;
      if (expired) message += ` ${count(expired, 'expired entry', 'expired entries')} removed from the database.`;
      toast(message, 'success');
    } else if (result?.sent) {
      toast(result.host
        ? `Sent ${count(result.sent, 'decision')} to ${result.host.name}'s computer, which saves them to the spreadsheets.`
        : `Sent ${count(result.sent, 'decision')}. They'll be saved when the host computer's app is open.`, 'success');
    }
    await refresh();
  }

  // Activity -------------------------------------------------------------

  function renderActivity() {
    const { watcher, settings, database, duplicates, log, team } = ui.data;
    $('#inbox-status').textContent = isHost()
      ? {
        watching: 'Watching for new files',
        error: watcher.message || 'The inbox folder is unavailable.',
        stopped: 'Not watching',
      }[watcher.state]
      : team.host
        ? `${team.host.name}'s computer imports new files.`
        : 'The host imports new files. Its app isn\'t open, so files wait here.';
    $('#inbox-path').textContent = settings.inboxDir;
    $('#rescan').disabled = !isHost();
    $('#rescan').title = isHost() ? '' : 'Only the host computer imports files from the inbox.';

    $('#people-body').innerHTML = team.people.map((p) => `
      <tr>
        <td class="file">${esc(p.name)}${p.isMe ? ' <span class="muted">(you)</span>' : ''}</td>
        <td>${p.role === 'host' ? '<span class="tag tag-green">Host</span>' : '<span class="tag tag-mint">Reviewing</span>'}</td>
        <td>${esc(p.computer)}</td>
        <td class="notes">${esc(p.viewing ?? '')}</td>
      </tr>`).join('');

    const figure = (book) => (book.rows === null ? 'Unreadable' : count(book.rows, 'entry', 'entries'));
    $('#db-count').textContent = figure(database);
    $('#db-count').title = database.error ?? '';
    $('#dup-count').textContent = figure(duplicates);
    $('#dup-count').title = duplicates.error ?? '';
    $('#db-retention').textContent = settings.retentionDays > 0
      ? `Entries are kept for ${count(settings.retentionDays, 'day')}.`
      : 'Entries are kept indefinitely.';

    const tags = {
      imported: '<span class="tag tag-mint">Imported</span>',
      skipped: '<span class="tag tag-gray">Skipped</span>',
      error: '<span class="tag tag-outline">Not imported</span>',
    };
    $('#log-empty').hidden = log.length > 0;
    $('#log-body').innerHTML = log.map((entry) => {
      const notes = [entry.message];
      if (entry.expired) notes.push(`${count(entry.expired, 'expired entry', 'expired entries')} removed from the database.`);
      const num = (n) => (n === undefined ? '' : n.toLocaleString());
      return `
        <tr class="status-${esc(entry.status)}">
          <td class="when">${esc(formatWhen(entry.at))}</td>
          <td class="file">${esc(entry.file)}</td>
          <td>${tags[entry.status] ?? ''}</td>
          <td class="num">${num(entry.rows)}</td>
          <td class="num">${num(entry.added)}</td>
          <td class="num">${num(entry.flagged)}</td>
          <td class="notes">${esc(notes.filter(Boolean).join(' '))}</td>
        </tr>`;
    }).join('');
  }

  function reportCopied(result) {
    if (!result) return;
    if (result.copied) toast(`${count(result.copied, 'file')} added to the inbox.`, 'success');
    if (result.ignored) toast(`${count(result.ignored, 'file')} skipped: only .xlsx, .xls, .xlsm, .csv and .ods files can be imported.`, 'info');
  }

  // Settings -------------------------------------------------------------

  const form = $('#settings-form');

  function loadDraft() {
    ui.draft = structuredClone(ui.data.settings);
    ui.draftDirty = false;
    ui.errors = {};
    form.inboxDir.value = ui.draft.inboxDir;
    form.dataDir.value = ui.draft.dataDir;
    form.personName.value = ui.draft.personName;
    form.isHost.checked = ui.draft.isHost;
    form.threshold.value = ui.draft.threshold;
    form.retentionDays.value = ui.draft.retentionDays;
    renderSharing();
    renderColumns();
    renderErrors();
    markDirty(false);
  }

  /** Who is using the data folder, and which settings this computer may change. */
  function renderSharing() {
    const { team } = ui.data;
    const role = {
      host: 'This computer is the host.',
      'waiting-host': `This computer is set as the host, but ${hostName() ?? 'another computer'}'s computer is acting as host, so this computer is reviewing for now.`,
      reviewer: team.host ? `${team.host.name}'s computer is the host, and this computer reviews.` : 'No host computer is running right now, and this computer reviews.',
    }[team.role];
    const others = team.people.filter((p) => !p.isMe).map((p) => `${p.name} (${p.role === 'host' ? 'host' : 'reviewing'})`);
    $('#sharing-status').textContent = `${role} ${others.length ? `Also using this data folder: ${listText(others)}.` : 'Nobody else is using this data folder right now.'}`;

    const canEdit = isHost();
    $('#shared-settings').disabled = !canEdit;
    $('#shared-note').hidden = canEdit;
    $('#shared-note').textContent = 'Everyone using this data folder shares the matching and retention settings, and only the host can change them.'
      + (team.host ? ` ${team.host.name}'s computer is the host.` : '');
    $('#open-clear').disabled = !canEdit;
    $('#clear-host-only').hidden = canEdit;
  }

  function markDirty(dirty = true) {
    ui.draftDirty = dirty;
    $('#settings-status').textContent = dirty ? 'Unsaved changes' : '';
    $('#settings-dirty-dot').hidden = !dirty;
  }

  // The two column lists: requiredFields must all match; of fields, at least
  // `threshold` must match. A column can be checked in only one of them.
  const LISTS = { requiredFields: '#required-list', fields: '#optional-list' };

  function inList(list, name) {
    const key = normalizeHeader(name);
    return ui.draft[list].some((f) => normalizeHeader(f) === key);
  }

  function renderColumns() {
    if (!ui.draft) return;
    const all = new Map();
    for (const name of [...ui.data.knownColumns, ...ui.extraColumns, ...ui.draft.requiredFields, ...ui.draft.fields]) {
      const key = normalizeHeader(name);
      if (key && !all.has(key)) all.set(key, name);
    }
    const names = [...all.values()];
    for (const [list, selector] of Object.entries(LISTS)) {
      const other = list === 'fields' ? 'requiredFields' : 'fields';
      const otherLabel = list === 'fields' ? 'columns that must always match' : 'columns where some must match';
      $(selector).innerHTML = names.length
        ? names.map((name) => {
          const taken = inList(other, name);
          return `
            <label class="check${taken ? ' taken' : ''}"${taken ? ` title="Already checked in ${otherLabel}"` : ''}>
              <input type="checkbox" data-list="${list}" data-column="${esc(name)}"${inList(list, name) ? ' checked' : ''}${taken ? ' disabled' : ''}>
              <span>${esc(name)}</span>
            </label>`;
        }).join('')
        : '<p class="muted small">No columns are known yet. Read them from a spreadsheet, or add them by name.</p>';
    }
    $('#field-count').textContent = ui.draft.fields.length;
    form.threshold.max = Math.max(ui.draft.fields.length, 1);
    form.threshold.disabled = !ui.draft.fields.length;
    renderRuleSummary();
  }

  /** Spells out the matching rule being edited, e.g. "Flag an entry when A matches, and at least 2 of B, C and D also match." */
  function renderRuleSummary() {
    const { requiredFields: required, fields: optional } = ui.draft;
    const atLeast = Number(form.threshold.value);
    let text;
    if (!required.length && !optional.length) {
      text = 'No columns are checked, so files in the inbox will wait until you choose some.';
    } else {
      const parts = [];
      if (required.length) {
        parts.push(`${listText(required)} ${['matches', 'both match'][required.length - 1] ?? 'all match'}`);
      }
      if (optional.length) {
        const some = optional.length === 1 ? optional[0]
          : atLeast === optional.length ? `${optional.length === 2 ? 'both' : `all ${optional.length} of`} ${listText(optional)}`
            : `at least ${Number.isInteger(atLeast) && atLeast > 0 ? atLeast : '?'} of ${listText(optional)}`;
        parts.push(`${some} ${required.length ? 'also ' : ''}match${optional.length === 1 ? 'es' : ''}`);
      }
      text = `Flag an entry when ${parts.join(', and ')}.`;
    }
    $('#rule-summary').textContent = text;
  }

  function renderErrors() {
    for (const el of $$('[data-error-for]')) el.textContent = ui.errors[el.dataset.errorFor] ?? '';
    for (const name of ['dataDir', 'inboxDir', 'personName', 'threshold', 'retentionDays']) {
      form[name].classList.toggle('invalid', Boolean(ui.errors[name]));
    }
  }

  /** Adds a column name to both lists, unchecked. */
  function addColumn(name) {
    const clean = name.replace(/\s+/g, ' ').trim();
    if (!clean) return;
    if (!ui.extraColumns.some((c) => normalizeHeader(c) === normalizeHeader(clean))) ui.extraColumns.push(clean);
    renderColumns();
    toast(`Added ${clean}. Check it in either list to compare it.`, 'info');
  }

  form.addEventListener('input', (event) => {
    const { name, value } = event.target;
    if (['dataDir', 'inboxDir', 'personName', 'threshold', 'retentionDays'].includes(name)) {
      ui.draft[name] = value;
      markDirty();
      if (name === 'threshold') renderRuleSummary();
    }
  });

  form.addEventListener('change', (event) => {
    if (event.target.id === 'isHost') {
      ui.draft.isHost = event.target.checked;
      markDirty();
      return;
    }
    const { list, column } = event.target.dataset ?? {};
    if (!list || column === undefined) return;
    if (event.target.checked) {
      if (!inList(list, column)) ui.draft[list].push(column);
    } else {
      ui.draft[list] = ui.draft[list].filter((f) => normalizeHeader(f) !== normalizeHeader(column));
    }
    markDirty();
    renderColumns();
  });

  $('#add-column').addEventListener('click', () => {
    addColumn($('#new-column').value);
    $('#new-column').value = '';
  });
  $('#new-column').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      $('#add-column').click();
    }
  });

  $('#load-columns').addEventListener('click', async () => {
    const headers = await attempt(() => api.readColumnsFromFile());
    if (!headers) return;
    if (!headers.length) {
      toast('No column names were found in the first row of that spreadsheet.', 'error');
      return;
    }
    const known = new Set(ui.extraColumns.map(normalizeHeader));
    ui.extraColumns.push(...headers.filter((h) => !known.has(normalizeHeader(h))));
    renderColumns();
    toast(`Read ${count(headers.length, 'column name')}. Check the ones to compare.`, 'success');
  });

  $$('[data-browse]').forEach((button) => button.addEventListener('click', async () => {
    const name = button.dataset.browse;
    const folder = await attempt(() => api.chooseFolder(form[name].value));
    if (!folder) return;
    form[name].value = folder;
    ui.draft[name] = folder;
    markDirty();
  }));

  $('#discard-settings').addEventListener('click', () => loadDraft());

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const toNumber = (v) => (String(v).trim() === '' ? NaN : Number(v));
    const payload = {
      ...ui.draft,
      threshold: toNumber(form.threshold.value),
      retentionDays: toNumber(form.retentionDays.value),
    };
    const result = await attempt(() => api.saveSettings(payload));
    if (!result) return;
    if (result.errors) {
      ui.errors = result.errors;
      renderErrors();
      toast('Some settings need attention before they can be saved.', 'error');
      return;
    }
    if (result.cancelled) {
      toast('Settings were not saved.', 'info');
      return;
    }
    ui.data.settings = result.settings;
    ui.selectedId = null;
    loadDraft();
    await refresh();
    const joined = result.role === 'reviewer' && hostName()
      ? `Switched to the new data folder. ${hostName()}'s computer is its host, so this computer reviews.`
      : 'Switched to the new data folder. Its matching settings are now shown here.';
    toast({
      use: joined,
      copy: 'Your data was copied to the new data folder, and the app is now using it.',
      empty: 'Settings saved. The app is now using the new, empty data folder.',
    }[result.plan] ?? (isHost() ? 'Settings saved. The inbox has been rescanned.' : 'Settings saved.'), 'success');
  });

  // Clear all data -------------------------------------------------------

  const CLEAR_PHRASE = 'Clear ALL DATA'; // the main process checks the same phrase
  const clearDialog = $('#clear-dialog');
  const clearInput = $('#clear-confirm');

  $('#open-clear').addEventListener('click', () => {
    const { database, duplicates, queue } = ui.data;
    const rows = (book, file) => (book.rows === null ? `Everything in ${file}` : `${count(book.rows, 'entry', 'entries')} in ${file}`);
    const items = [
      rows(database, 'Database.xlsx'),
      rows(duplicates, 'Duplicates.xlsx'),
      `${count(queue.length, 'entry', 'entries')} waiting for review, including decisions not yet saved`,
      'The activity log, so files imported before can be imported again',
    ];
    $('#clear-summary').innerHTML = items.map((item) => `<li>${esc(item)}</li>`).join('');
    clearInput.value = '';
    $('#clear-submit').disabled = true;
    clearDialog.showModal();
    clearInput.focus();
  });

  clearInput.addEventListener('input', () => {
    $('#clear-submit').disabled = clearInput.value.trim() !== CLEAR_PHRASE;
  });

  $('#clear-cancel').addEventListener('click', () => clearDialog.close());

  $('#clear-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (clearInput.value.trim() !== CLEAR_PHRASE) return;
    $('#clear-submit').disabled = true;
    const removed = await attempt(() => api.clearAllData(clearInput.value));
    if (!removed) {
      $('#clear-submit').disabled = false; // e.g. a file open in Excel; fix it and try again
      return;
    }
    clearDialog.close();
    clearErrorToasts();
    ui.selectedId = null;
    toast(
      `All data cleared: ${count(removed.databaseRows, 'database entry', 'database entries')}, ` +
      `${count(removed.duplicateRows, 'duplicate')} and ${count(removed.reviewItems, 'entry', 'entries')} awaiting review. ` +
      'Backup copies are in the Backups folder.',
      'success',
    );
    await refresh();
  });

  // Global events --------------------------------------------------------

  document.addEventListener('click', (event) => {
    const target = event.target.closest('[data-view], [data-open], [data-decide], .queue-item');
    if (!target) return;
    if (target.dataset.view) showView(target.dataset.view);
    else if (target.dataset.open) attempt(() => api.open(target.dataset.open));
    else if (target.dataset.decide) decide(target.dataset.decide, { toggle: true });
    else if (target.classList.contains('queue-item')) {
      ui.selectedId = target.dataset.id;
      renderReview();
    }
  });

  $('#apply').addEventListener('click', saveDecisions);
  $('#mark-rest').addEventListener('click', markRestUnique);
  $('#rescan').addEventListener('click', async () => {
    const found = await attempt(() => api.rescanInbox());
    if (found !== undefined) toast(found ? `Checking ${count(found, 'file')} in the inbox.` : 'The inbox is empty.', 'info');
  });
  $('#add-files').addEventListener('click', async () => reportCopied(await attempt(() => api.chooseFilesForInbox())));

  document.addEventListener('keydown', (event) => {
    if (ui.view !== 'review' || !ui.data?.queue.length) return;
    if (event.target.closest('input, textarea, select')) return;
    if (event.ctrlKey && event.key.toLowerCase() === 's') {
      event.preventDefault();
      saveDecisions();
      return;
    }
    if (event.ctrlKey || event.altKey || event.metaKey) return;
    const key = event.key.toLowerCase();
    if (key === 'd') decide('duplicate');
    else if (key === 'n') decide('unique');
    else if (key === 'u' || key === 'backspace') decide(null);
    else if (key === 'arrowdown' || key === 'j') move(1);
    else if (key === 'arrowup' || key === 'k') move(-1);
    else return;
    event.preventDefault();
  });

  // Dropping files anywhere in the window copies them into the inbox.
  let dragDepth = 0;
  const hasFiles = (event) => [...(event.dataTransfer?.types ?? [])].includes('Files');
  window.addEventListener('dragenter', (event) => {
    if (!hasFiles(event)) return;
    dragDepth++;
    $('#drop-overlay').hidden = false;
  });
  window.addEventListener('dragleave', (event) => {
    if (!hasFiles(event)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) $('#drop-overlay').hidden = true;
  });
  window.addEventListener('dragover', (event) => event.preventDefault());
  window.addEventListener('drop', async (event) => {
    event.preventDefault();
    dragDepth = 0;
    $('#drop-overlay').hidden = true;
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (files.length) reportCopied(await attempt(() => api.addFilesToInbox(files)));
  });

  refresh();
})();
