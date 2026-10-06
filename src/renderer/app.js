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
    if (first) showView(data.settings.fields.length ? 'review' : 'settings');
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
    if (ui.view === 'settings') renderColumns();
  }

  function showView(view) {
    ui.view = view;
    for (const name of ['review', 'activity', 'settings']) $(`#view-${name}`).hidden = name !== view;
    $$('.tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.view === view));
    render();
  }

  // Header ---------------------------------------------------------------

  function renderHeader() {
    const { watcher, settings, queue } = ui.data;
    const status = $('#watch-status');
    status.className = `watch-status ${watcher.state}`;
    const text = {
      watching: `Watching ${basename(settings.inboxDir)}`,
      error: 'Inbox unavailable',
      stopped: 'Not watching the inbox',
    }[watcher.state];
    status.innerHTML = `<span>${esc(text)}</span>`;
    status.title = watcher.message || settings.inboxDir;

    const open = queue.filter((item) => !item.decision).length;
    const badge = $('#review-count');
    badge.hidden = !open;
    badge.textContent = open.toLocaleString();
    $('#settings-dirty-dot').hidden = !ui.draftDirty;
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

  function itemSummary(item) {
    const values = item.fields.map((f) => valueIn(item.headers, item.record, f)).filter(Boolean);
    return values.join(' · ') || 'Compared columns are blank';
  }

  function selectedItem() {
    return ui.data.queue.find((item) => item.id === ui.selectedId) ?? null;
  }

  function ensureSelection() {
    const { queue } = ui.data;
    if (!selectedItem()) ui.selectedId = (queue.find((item) => !item.decision) ?? queue[0])?.id ?? null;
  }

  function renderReview() {
    const { queue, settings } = ui.data;
    ensureSelection();

    const empty = !queue.length;
    $('#review-panes').hidden = empty;
    $('#apply-bar').hidden = empty;
    $('#review-empty').hidden = !empty;
    if (empty) {
      $('#review-empty').innerHTML = settings.fields.length
        ? `<h1>Nothing to review</h1>
           <p>Spreadsheets dropped into the inbox are checked automatically. Entries that look like duplicates will be listed here.</p>
           <p class="path">${esc(settings.inboxDir)}</p>
           <button class="btn btn-secondary" data-open="inbox">Open inbox folder</button>`
        : `<h1>Choose the columns to compare</h1>
           <p>Before spreadsheets can be checked, choose the columns that identify an entry and how many of them must match.</p>
           <button class="btn btn-primary" data-view="settings">Open Settings</button>`;
      return;
    }

    const open = queue.filter((item) => !item.decision);
    const dupes = queue.filter((item) => item.decision === 'duplicate').length;
    const uniques = queue.filter((item) => item.decision === 'unique').length;
    $('#queue-summary').textContent = open.length
      ? `${count(open.length, 'entry', 'entries')} to review${dupes + uniques ? ` · ${(dupes + uniques).toLocaleString()} decided` : ''}`
      : `All ${count(queue.length, 'entry', 'entries')} decided. Save to finish.`;
    $('#mark-rest').disabled = !open.length;

    renderQueueList();
    renderDetail(selectedItem());

    const decided = dupes + uniques;
    $('#apply').disabled = !decided;
    $('#apply').textContent = decided ? `Save ${count(decided, 'decision')}` : 'Save decisions';
    const parts = [];
    if (dupes) parts.push(`${count(dupes, 'duplicate')} to Duplicates.xlsx`);
    if (uniques) parts.push(`${count(uniques, 'entry', 'entries')} to Database.xlsx`);
    $('#apply-summary').innerHTML = decided
      ? `Ready to save: ${esc(listText(parts))}.${open.length ? ` <span class="muted">${esc(count(open.length, 'entry', 'entries'))} still to review.</span>` : ''}`
      : '<span class="muted">Mark each entry as a duplicate or not, then save your decisions.</span>';
  }

  function renderQueueList() {
    const groups = [];
    for (const item of ui.data.queue) {
      const key = `${item.fileName}|${item.importedAt}`;
      if (groups.at(-1)?.key !== key) groups.push({ key, fileName: item.fileName, importedAt: item.importedAt, items: [] });
      groups.at(-1).items.push(item);
    }
    const tag = (item) => ({
      duplicate: '<span class="tag tag-outline">Duplicate</span>',
      unique: '<span class="tag tag-mint">Not a duplicate</span>',
    }[item.decision] ?? '<span></span>');

    $('#queue-list').innerHTML = groups.map((group) => `
      <div class="queue-group">
        <div class="group-head">
          <strong title="${esc(group.fileName)}">${esc(group.fileName)}</strong>
          <span>${esc(formatDay(group.importedAt))}</span>
        </div>
        ${group.items.map((item) => {
          const best = item.matches[0];
          return `
          <button class="queue-item${item.id === ui.selectedId ? ' selected' : ''}${item.decision ? ' decided' : ''}" data-id="${esc(item.id)}">
            <span class="qi-row">Row ${esc(item.rowNumber)}</span>
            ${tag(item)}
            <span class="qi-summary">${esc(itemSummary(item))}</span>
            <span class="qi-meta">${esc(KIND_LABELS[best.kind])} · ${best.fields.length} of ${item.fields.length} columns match</span>
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
    let lede = `Matches ${matchPhrase(best)} on ${listText(best.fields)}: ${best.fields.length} of ${item.fields.length} compared columns.`;
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
    const compared = item.fields.map((f) => resolveHeader(item.headers, f) ?? f);
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
      return `<tr><th scope="row">${esc(label)}</th>${cells.join('')}</tr>`;
    };

    detail.innerHTML = `
      <div class="detail-head">
        <div>
          <p class="eyebrow">${esc(item.fileName)} · Row ${esc(item.rowNumber)}</p>
          <h1>Possible duplicate</h1>
          <p class="lede">${esc(lede)}</p>
        </div>
        <div class="decision">
          <button class="btn btn-secondary" data-decide="duplicate" aria-pressed="${item.decision === 'duplicate'}">Duplicate <kbd>D</kbd></button>
          <button class="btn btn-secondary" data-decide="unique" aria-pressed="${item.decision === 'unique'}">Not a duplicate <kbd>N</kbd></button>
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
    const next = queue.slice(i + 1).find((item) => !item.decision) ?? queue.slice(0, i).find((item) => !item.decision);
    if (next) ui.selectedId = next.id;
  }

  async function decide(decision, { toggle = false } = {}) {
    const item = selectedItem();
    if (!item) return;
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
    const rest = ui.data.queue.filter((item) => !item.decision);
    if (!rest.length) return;
    const ok = window.confirm(
      `Mark ${count(rest.length, 'remaining entry', 'remaining entries')} as not duplicates?\n\n` +
      'They will be added to the database when you save your decisions.',
    );
    if (!ok) return;
    for (const item of rest) item.decision = 'unique';
    render();
    await attempt(() => api.decide(rest.map((item) => item.id), 'unique'));
  }

  async function saveDecisions() {
    if (!ui.data.queue.some((item) => item.decision)) return;
    $('#apply').disabled = true;
    const result = await attempt(() => api.applyDecisions());
    if (result) {
      $$('.toast.error').forEach((el) => el.remove()); // e.g. an earlier "file is open" warning
      const parts = [];
      if (result.duplicates) parts.push(`${count(result.duplicates, 'entry', 'entries')} added to Duplicates.xlsx`);
      if (result.added) parts.push(`${count(result.added, 'entry', 'entries')} added to Database.xlsx`);
      let message = `Saved: ${listText(parts)}.`;
      if (result.expired) message += ` ${count(result.expired, 'expired entry', 'expired entries')} removed from the database.`;
      toast(message, 'success');
    }
    await refresh();
  }

  // Activity -------------------------------------------------------------

  function renderActivity() {
    const { watcher, settings, database, duplicates, log } = ui.data;
    $('#inbox-status').textContent = {
      watching: 'Watching for new files',
      error: watcher.message || 'The inbox folder is unavailable.',
      stopped: 'Not watching',
    }[watcher.state];
    $('#inbox-path').textContent = settings.inboxDir;

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
    form.outputDir.value = ui.draft.outputDir;
    form.threshold.value = ui.draft.threshold;
    form.retentionDays.value = ui.draft.retentionDays;
    renderColumns();
    renderErrors();
    markDirty(false);
  }

  function markDirty(dirty = true) {
    ui.draftDirty = dirty;
    $('#settings-status').textContent = dirty ? 'Unsaved changes' : '';
    $('#settings-dirty-dot').hidden = !dirty;
  }

  function isSelected(name) {
    const key = normalizeHeader(name);
    return ui.draft.fields.some((f) => normalizeHeader(f) === key);
  }

  function renderColumns() {
    if (!ui.draft) return;
    const all = new Map();
    for (const name of [...ui.data.knownColumns, ...ui.extraColumns, ...ui.draft.fields]) {
      const key = normalizeHeader(name);
      if (key && !all.has(key)) all.set(key, name);
    }
    const names = [...all.values()];
    $('#column-list').innerHTML = names.length
      ? names.map((name) => {
        const position = ui.draft.fields.findIndex((f) => normalizeHeader(f) === normalizeHeader(name));
        return `
          <label class="check">
            <input type="checkbox" data-column="${esc(name)}"${position >= 0 ? ' checked' : ''}>
            <span>${esc(name)}</span>
          </label>`;
      }).join('')
      : '<p class="muted small">No columns are known yet. Read them from a spreadsheet, or add them by name.</p>';
    $('#known-columns').innerHTML = names.filter((n) => !isSelected(n)).map((n) => `<option value="${esc(n)}"></option>`).join('');
    $('#field-count').textContent = ui.draft.fields.length;
    form.threshold.max = Math.max(ui.draft.fields.length, 1);
  }

  function renderErrors() {
    for (const el of $$('[data-error-for]')) el.textContent = ui.errors[el.dataset.errorFor] ?? '';
    for (const name of ['inboxDir', 'outputDir', 'threshold', 'retentionDays']) {
      form[name].classList.toggle('invalid', Boolean(ui.errors[name]));
    }
  }

  function addColumn(name) {
    const clean = name.replace(/\s+/g, ' ').trim();
    if (!clean) return;
    if (!isSelected(clean)) ui.draft.fields.push(clean);
    if (!ui.extraColumns.some((c) => normalizeHeader(c) === normalizeHeader(clean))) ui.extraColumns.push(clean);
    markDirty();
    renderColumns();
  }

  form.addEventListener('input', (event) => {
    const { name, value } = event.target;
    if (['inboxDir', 'outputDir', 'threshold', 'retentionDays'].includes(name)) {
      ui.draft[name] = value;
      markDirty();
    }
  });

  form.addEventListener('change', (event) => {
    const column = event.target.dataset?.column;
    if (column === undefined) return;
    if (event.target.checked) {
      if (!isSelected(column)) ui.draft.fields.push(column);
    } else {
      ui.draft.fields = ui.draft.fields.filter((f) => normalizeHeader(f) !== normalizeHeader(column));
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
    ui.data.settings = result.settings;
    loadDraft();
    toast('Settings saved. The inbox has been rescanned.', 'success');
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
