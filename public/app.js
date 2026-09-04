(() => {
  'use strict';

  const app = document.querySelector('#app');
  const toast = document.querySelector('#toast');
  let csrf = '';
  let boot = {};
  let current = 'dashboard';
  let poller;
  let pollerFast = false;
  let loginPoller;
  let scanRunId = null;
  let scanBaseline = 0;
  let candidateSort = 'start';

  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  /** Renders the small, safe Markdown subset used in agent replies. */
  const markdown = (value) => {
    const code = [];
    const inline = (text) => esc(text).replace(/`([^`]+)`/g, (_match, content) => { code.push(`<code>${content}</code>`); return `\u0000${code.length - 1}\u0000`; })
      .replace(/\[([^\]]+)]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/\*([^*]+)\*/g, '<em>$1</em>')
      .replace(/\u0000(\d+)\u0000/g, (_match, index) => code[Number(index)] || '');
    const lines = String(value ?? '').split(/\r?\n/), output = [];
    let inList = false;
    for (const line of lines) {
      const item = line.match(/^\s*[-*]\s+(.+)/);
      if (item) { if (!inList) output.push('<ul>'); inList = true; output.push(`<li>${inline(item[1])}</li>`); continue; }
      if (inList) { output.push('</ul>'); inList = false; }
      const heading = line.match(/^(#{1,3})\s+(.+)/);
      if (heading) output.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`);
      else if (line.trim()) output.push(`<p>${inline(line)}</p>`);
    }
    if (inList) output.push('</ul>');
    return output.join('');
  };
  const button = (text, kind = '', attributes = '') => `<button class="button ${kind}" ${attributes}>${text}</button>`;
  const count = (value) => Number(value) || 0;
  const formatDate = (value) => {
    if (!value) return 'Not available';
    const date = new Date(value);
    return Number.isNaN(date.valueOf()) ? String(value) : date.toLocaleString();
  };
  const sortTime = (value, empty) => {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? empty : parsed;
  };
  const eventWhen = (candidate) => {
    if (!candidate.start) return 'Time to be confirmed';
    const start = formatDate(candidate.start);
    const end = candidate.end ? formatDate(candidate.end) : '';
    const zone = candidate.timezone ? ` · ${candidate.timezone}` : '';
    return end ? `${start} – ${end}${zone}` : `${start}${zone}`;
  };
  const candidateMeta = (candidate) => {
    const parts = [];
    if (candidate.location) parts.push(candidate.location);
    if (candidate.organizer) parts.push(candidate.organizer);
    if (candidate.registrationUrl) parts.push(candidate.registrationUrl);
    parts.push(`${Math.round((Number(candidate.confidence) || 0) * 100)}% confidence`);
    return parts.join(' · ');
  };
  const sortCandidates = (rows, sort) => {
    const copy = rows.slice();
    const byTitle = (left, right) => String(left.title || '').localeCompare(String(right.title || ''), undefined, { sensitivity: 'base' });
    const comparators = {
      start: (left, right) => sortTime(left.start, Number.POSITIVE_INFINITY) - sortTime(right.start, Number.POSITIVE_INFINITY) || byTitle(left, right),
      startNewest: (left, right) => sortTime(right.start, Number.NEGATIVE_INFINITY) - sortTime(left.start, Number.NEGATIVE_INFINITY) || byTitle(left, right),
      recent: (left, right) => sortTime(right.updatedAt, 0) - sortTime(left.updatedAt, 0),
      title: byTitle,
      confidence: (left, right) => (Number(right.confidence) || 0) - (Number(left.confidence) || 0) || byTitle(left, right),
      kind: (left, right) => String(left.changeKind || '').localeCompare(String(right.changeKind || '')) || sortTime(left.start, Number.POSITIVE_INFINITY) - sortTime(right.start, Number.POSITIVE_INFINITY),
    };
    copy.sort(comparators[sort] || comparators.start);
    return copy;
  };
  const resolvedZone = (timeZone) => {
    try {
      Intl.DateTimeFormat('en-US', { timeZone }).format(new Date());
      return timeZone;
    } catch {
      return Intl.DateTimeFormat().resolvedOptions().timeZone;
    }
  };
  const tzParts = (date, timeZone) => {
    try {
      const parts = {};
      for (const part of new Intl.DateTimeFormat('en-US', {
        timeZone: resolvedZone(timeZone), hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
      }).formatToParts(date)) {
        if (part.type !== 'literal') parts[part.type] = part.value;
      }
      return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour) % 24, minute: Number(parts.minute), second: Number(parts.second) };
    } catch {
      return { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate(), hour: date.getHours(), minute: date.getMinutes(), second: date.getSeconds() };
    }
  };
  const wallTimeToIso = (year, month, day, hour, minute, timeZone) => {
    const utcGuess = Date.UTC(year, month - 1, day, hour, minute, 0);
    const offsetAt = (timestamp) => {
      const parts = tzParts(new Date(timestamp), timeZone);
      return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - timestamp;
    };
    const once = utcGuess - offsetAt(utcGuess);
    return new Date(utcGuess - offsetAt(once)).toISOString();
  };
  const formatPickerLabel = (value, timeZone) => {
    if (!value) return 'Choose date and time';
    const date = new Date(value);
    if (Number.isNaN(date.valueOf())) return String(value);
    return date.toLocaleString(undefined, { timeZone: resolvedZone(timeZone), weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  };
  const notify = (text, isError = false) => {
    toast.textContent = text;
    toast.style.borderColor = isError ? '#e35d75' : '';
    toast.classList.add('show');
    clearTimeout(notify.timer);
    notify.timer = setTimeout(() => toast.classList.remove('show'), 4500);
  };

  /** Updates the Calendar review count without sending browser notifications. */
  function updatePendingBadge(value) {
    const pending = count(value);
    document.title = pending ? `(${pending}) School Manager` : 'School Manager';
    document.querySelectorAll('[data-nav-badge]').forEach((element) => {
      element.hidden = !pending;
      element.textContent = pending > 99 ? '99+' : String(pending);
    });
  }

  async function api(path, options = {}) {
    let response;
    try {
      response = await fetch(path, {
        ...options,
        headers: {
          ...(options.body == null || options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
          'X-CSRF-Token': csrf,
          ...(options.headers || {}),
        },
      });
    } catch {
      throw new Error('Network connection failed. Please try again.');
    }
    let data = {};
    try { data = await response.json(); } catch { /* API responses are JSON. */ }
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
    return data;
  }

  function shell(view) {
    const titles = { dashboard: 'Overview', candidates: 'Review queue', history: 'History', settings: 'Settings' };
    const nav = [['dashboard', '⌂', 'Overview'], ['candidates', '◈', 'Review queue'], ['history', '◷', 'History'], ['settings', '⚙', 'Settings']];
    return `<div class="shell"><aside class="sidebar"><div class="brand"><i>✦</i> School Manager</div><nav>${nav.map(([id, icon, label]) => `<button class="${view === id ? 'active' : ''}" data-view="${id}"><span class="ico">${icon}</span>${label}${id === 'candidates' ? '<span class="nav-badge" data-nav-badge hidden></span>' : ''}</button>`).join('')}</nav><div class="side-foot">${button('Sign out', 'ghost', 'data-action="logout"')}</div></aside><section class="content"><header class="topbar"><div><div class="eyebrow">Email → Calendar</div><h1>${titles[view]}</h1></div></header><div id="view"><div class="loading"><span class="spinner"></span></div></div></section><nav class="mobile-nav">${nav.map(([id, , label]) => `<button class="${view === id ? 'active' : ''}" data-view="${id}">${label}${id === 'candidates' ? '<span class="nav-badge" data-nav-badge hidden></span>' : ''}</button>`).join('')}</nav></div>`;
  }

  function bindShell() {
    document.querySelectorAll('[data-view]').forEach((element) => { element.onclick = () => navigate(element.dataset.view); });
    document.querySelector('[data-action="logout"]')?.addEventListener('click', async () => {
      try { await api('/api/auth/logout', { method: 'POST' }); location.reload(); } catch (error) { notify(error.message, true); }
    });
  }

  function setView(html) { document.querySelector('#view').innerHTML = html; }

  async function navigate(view) {
    current = view;
    clearInterval(poller);
    app.innerHTML = shell(view);
    bindShell();
    try {
      if (view === 'dashboard') await dashboard();
      if (view === 'candidates') await candidates('pending');
      if (view === 'history') await candidates('history');
      if (view === 'settings') await settings();
    } catch (error) {
      setView(`<div class="card notice error">${esc(error.message)}</div>`);
    }
  }

  async function dashboard() {
    clearInterval(poller);
    const [status, queue, pending] = await Promise.all([
      api('/api/dashboard'),
      api('/api/queue'),
      api('/api/candidates?status=pending').catch(() => []),
    ]);
    renderDashboard(status, queue, Array.isArray(pending) ? pending : []);
    const poll = async () => {
      if (current !== 'dashboard') return;
      try {
        const [latestStatus, latestQueue, latestPending] = await Promise.all([api('/api/dashboard'), api('/api/queue'), api('/api/candidates?status=pending').catch(() => [])]);
        renderDashboard(latestStatus, latestQueue, Array.isArray(latestPending) ? latestPending : []);
        const fast = queueActive(latestQueue, latestStatus);
        if (pollerFast !== fast) {
          clearInterval(poller);
          poller = setInterval(poll, fast ? 1000 : 30000);
          pollerFast = fast;
        }
      } catch { /* Leave the last useful status visible. */ }
    };
    pollerFast = queueActive(queue, status);
    poller = setInterval(poll, pollerFast ? 1000 : 30000);
  }

  function queueActive(queue, status) {
    return !queue.paused && (queue.running || status.scanRunning || count(queue.queued) > 0 || count(queue.processing) > 0 || queue.batchState === 'in_route' || queue.batchState === 'preparing' || queue.batchState === 'applying');
  }

  function renderDashboard(status, queue, pending) {
    updatePendingBadge(pending.length);
    const runTotal = count(queue.runTotal) || count(queue.queued) + count(queue.processing) + count(queue.runCompleted);
    const runCompleted = count(queue.runCompleted);
    const progress = runTotal ? Math.min(100, Math.round((runCompleted / runTotal) * 100)) : 0;
    const batchRoute = queue.batchMode && (queue.batchState === 'in_route' || queue.batchState === 'preparing' || queue.batchState === 'applying' || queue.batchMessage);
    const showBar = !queue.batchMode && queueActive(queue, status);
    const stateLabel = queue.paused ? 'Paused' : queue.batchState === 'in_route' ? 'Batch in route' : queue.batchState === 'preparing' ? 'Preparing batch' : status.scanRunning || queue.running ? 'Running' : 'Idle';
    const batchNotice = queue.batchMode && queue.batchMessage ? `<div class="notice ${queue.batchState === 'in_route' ? 'route' : ''}">${esc(queue.batchMessage)}</div>` : '';
    const progressBlock = batchRoute
      ? batchNotice
      : showBar
        ? `<div class="progress-label"><strong>Queue progress</strong><span>${runCompleted} of ${runTotal}</span></div><div class="progress" role="progressbar" aria-label="Queue progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${progress}"><span style="width:${progress}%"></span></div>${batchNotice}`
        : batchNotice;
    setView(`<div class="grid stats"><div class="card stat"><div class="label">Awaiting review</div><div class="num blue">${count(status.pendingCount)}</div></div><div class="card stat"><div class="label">Queued messages</div><div class="num yellow">${count(status.queuedCount)}</div></div><div class="card stat"><div class="label">Processing now</div><div class="num green">${count(queue.processing)}</div></div><div class="card stat"><div class="label">Failed messages</div><div class="num">${count(status.failedCount)}</div></div></div><div class="grid split section"><section class="card"><div class="section-head"><div><h2>Needs your attention</h2><p class="muted">${status.setupComplete ? 'Review proposed calendar changes before they are applied.' : 'Finish setup to begin reviewing meeting suggestions.'}</p></div>${button(status.setupComplete ? 'Open queue' : 'Finish setup', 'primary', 'data-go="candidates"')}</div>${candidateList(pending, true)}</section><section class="card"><div class="section-head"><h2>Queue control</h2><div class="queuebar"><span class="dot ${queue.paused ? 'paused' : queue.batchState === 'in_route' ? 'route' : ''}"></span>${esc(stateLabel)}</div></div><p class="muted">${count(queue.queued)} queued · ${count(queue.processing)} processing · ${count(queue.processed)} processed · ${count(queue.failed)} failed</p>${progressBlock}<small class="muted">Last successful scan: ${esc(formatDate(status.lastSuccessfulScan))}<br>Next scan: ${esc(status.nextScan || 'Not scheduled')}</small><div class="actions section">${queue.paused ? button('Resume queue', 'good', 'data-queue="resume"') : button('Pause queue', 'ghost', 'data-queue="pause"')}${count(queue.failed) ? button('Retry failed messages', 'ghost', 'data-retry-failed') : ''}${button('Scan now', 'primary', 'data-scan-now')}</div>${status.lastError ? `<div class="notice error">${esc(status.lastError)}</div>` : ''}</section></div><section class="card section connection-card"><h2>Connections</h2><p class="muted">Google: ${status.googleConnected ? 'Connected' : 'Not connected'} · OpenAI Codex: ${status.openaiConnected ? 'Connected' : 'Not connected'} · OpenRouter: ${status.openrouterConnected ? 'Connected' : 'Not connected'}</p></section>`);
    document.querySelector('[data-go]')?.addEventListener('click', () => status.setupComplete ? navigate('calendar') : wizardForStatus(status));
    document.querySelector('[data-queue]')?.addEventListener('click', queueAction);
    document.querySelector('[data-retry-failed]')?.addEventListener('click', retryFailedMessages);
    document.querySelector('[data-scan-now]')?.addEventListener('click', scanNow);
  }

  function candidateList(rows, compact = false) {
    if (!rows.length) return '<div class="empty">Nothing needs review right now.</div>';
    return rows.slice(0, compact ? 4 : 100).map((candidate) => {
      const id = Number(candidate.id);
      const kind = esc(candidate.changeKind || 'create');
      const title = esc(candidate.title || 'Untitled event');
      if (compact) {
        return `<article class="item"><span class="tag ${kind}">${kind}</span><div class="item-body"><div class="item-title">${title}</div><p>${esc(eventWhen(candidate))}</p></div></article>`;
      }
      const pending = candidate.status === 'pending';
      const actions = `<div class="actions">${pending ? `${button('Approve', 'good', `data-approve="${id}"`)}${button('Deny', 'danger', `data-deny="${id}"`)}` : ''}${button('Review', 'ghost', `data-review="${id}"`)}</div>`;
      return `<article class="item candidate"><div class="item-body"><div class="item-head"><span class="tag ${kind}">${kind}</span><div class="item-title">${title}</div></div><p>${esc(eventWhen(candidate))}</p><p>${esc(candidateMeta(candidate))}</p><p class="item-desc">${esc(candidate.description || 'No description provided.')}</p>${candidate.sourceUrl ? `<p><a href="${esc(candidate.sourceUrl)}" target="_blank" rel="noopener noreferrer">Open source email</a></p>` : ''}</div>${actions}</article>`;
    }).join('');
  }

  function bindCandidateList(rows) {
    document.querySelectorAll('[data-review]').forEach((element) => {
      element.onclick = () => review(rows.find((item) => Number(item.id) === Number(element.dataset.review)));
    });
    document.querySelectorAll('[data-approve]').forEach((element) => {
      element.onclick = () => decision(Number(element.dataset.approve), 'approve');
    });
    document.querySelectorAll('[data-deny]').forEach((element) => {
      element.onclick = () => decision(Number(element.dataset.deny), 'deny');
    });
  }

  async function candidates(status) {
    const data = await api(`/api/candidates?status=${status}`);
    const rows = Array.isArray(data) ? data : [];
    if (status === 'pending') updatePendingBadge(rows.length);
    const sortChoices = [
      ['start', 'Event date · soonest'],
      ['startNewest', 'Event date · latest'],
      ['recent', 'Recently proposed'],
      ['title', 'Title A–Z'],
      ['confidence', 'Highest confidence'],
      ['kind', 'Change type'],
    ];
    const renderList = () => {
      const sorted = sortCandidates(rows, candidateSort);
      const sortSelect = `<label class="sort-control"><span>Sort</span><select id="candidate-sort">${sortChoices.map(([value, label]) => `<option value="${esc(value)}" ${candidateSort === value ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select></label>`;
      setView(`<section class="card"><div class="section-head"><div><h2>${status === 'pending' ? 'Proposed calendar changes' : 'Decision history'}</h2><p class="muted">${status === 'pending' ? 'Create, update, and cancellation requests are clearly labelled for review.' : 'Approved, denied, and superseded proposals.'}</p></div><div class="queue-tools">${sortSelect}${status === 'pending' ? button('Scan inbox', 'primary', 'data-scan-now') : ''}</div></div>${candidateList(sorted)}</section>`);
      bindCandidateList(sorted);
      document.querySelector('[data-scan-now]')?.addEventListener('click', scanNow);
      document.querySelector('#candidate-sort').onchange = (event) => {
        candidateSort = event.target.value;
        renderList();
      };
    };
    renderList();
  }

  function datetimeField(id, label, value, timeZone) {
    return `<div class="field"><label for="${id}-trigger">${esc(label)}</label><button type="button" id="${id}-trigger" class="datetime-trigger${value ? '' : ' empty'}" aria-haspopup="dialog" aria-expanded="false"><span>${esc(formatPickerLabel(value, timeZone))}</span><b aria-hidden="true">▾</b></button><input id="${id}" type="hidden" value="${esc(value || '')}"></div>`;
  }

  function bindDatetimePickers() {
    const start = document.querySelector('#cstart');
    const end = document.querySelector('#cend');
    const view = document.querySelector('#view');
    if (!start || !end || !view) return;
    const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    view.insertAdjacentHTML('beforeend', `<dialog id="datetime-dialog" class="datetime-modal card" aria-labelledby="datetime-title"><div class="section-head"><h2 id="datetime-title">Choose date and time</h2>${button('Cancel', 'ghost', 'data-datetime-close type="button"')}</div><div class="cal-head"><div class="cal-month-year"><select id="datetime-month" aria-label="Month"></select><select id="datetime-year" aria-label="Year"></select></div><div class="cal-head-nav">${button('‹', 'ghost', 'data-datetime-prev type="button" aria-label="Previous month"')}${button('›', 'ghost', 'data-datetime-next type="button" aria-label="Next month"')}</div></div><div class="cal-weekdays">${weekdays.map((day) => `<span>${esc(day)}</span>`).join('')}</div><div id="datetime-grid" class="cal-grid" role="grid"></div><div class="datetime-time"><span>Time</span><select id="datetime-hour" aria-label="Hour"></select><span class="datetime-colon">:</span><select id="datetime-minute" aria-label="Minute"></select><select id="datetime-meridiem" aria-label="AM or PM"><option value="AM">AM</option><option value="PM">PM</option></select></div><div class="actions section datetime-actions">${button('Clear', 'ghost', 'data-datetime-clear type="button"')}${button('Apply', 'primary', 'data-datetime-apply type="button"')}</div></dialog>`);
    const dialog = document.querySelector('#datetime-dialog');
    const title = document.querySelector('#datetime-title');
    const monthSelect = document.querySelector('#datetime-month');
    const yearSelect = document.querySelector('#datetime-year');
    const hourSelect = document.querySelector('#datetime-hour');
    const minuteSelect = document.querySelector('#datetime-minute');
    const meridiemSelect = document.querySelector('#datetime-meridiem');
    const grid = document.querySelector('#datetime-grid');
    const state = { fieldId: 'cstart', viewYear: 0, viewMonth: 1, selected: { year: 0, month: 1, day: 1, hour: 9, minute: 0 } };
    monthSelect.innerHTML = Array.from({ length: 12 }, (_, index) => `<option value="${index + 1}">${esc(new Date(2000, index, 1).toLocaleString(undefined, { month: 'long' }))}</option>`).join('');
    hourSelect.innerHTML = Array.from({ length: 12 }, (_, index) => `<option value="${index + 1}">${index + 1}</option>`).join('');
    const zone = () => document.querySelector('#ctimezone')?.value || Intl.DateTimeFormat().resolvedOptions().timeZone;
    const pad = (value) => String(value).padStart(2, '0');
    const syncLabels = () => {
      ['cstart', 'cend'].forEach((id) => {
        const input = document.querySelector(`#${id}`);
        const trigger = document.querySelector(`#${id}-trigger`);
        if (!input || !trigger) return;
        trigger.classList.toggle('empty', !input.value);
        trigger.querySelector('span').textContent = formatPickerLabel(input.value, zone());
      });
    };
    const fillMinutes = (current) => {
      const steps = new Set(Array.from({ length: 12 }, (_, index) => index * 5));
      if (Number.isInteger(current)) steps.add(current);
      minuteSelect.innerHTML = [...steps].sort((left, right) => left - right).map((minute) => `<option value="${minute}">${pad(minute)}</option>`).join('');
      minuteSelect.value = String(current);
    };
    const fillYears = (selectedYear) => {
      const nowYear = tzParts(new Date(), zone()).year;
      const years = new Set();
      for (let year = nowYear - 2; year <= nowYear + 12; year += 1) years.add(year);
      years.add(selectedYear);
      yearSelect.innerHTML = [...years].sort((left, right) => left - right).map((year) => `<option value="${year}">${year}</option>`).join('');
      yearSelect.value = String(selectedYear);
    };
    const selectedKey = () => `${state.selected.year}-${state.selected.month}-${state.selected.day}`;
    const renderGrid = () => {
      const firstWeekday = new Date(state.viewYear, state.viewMonth - 1, 1).getDay();
      const daysHere = new Date(state.viewYear, state.viewMonth, 0).getDate();
      const today = tzParts(new Date(), zone());
      const todayKey = `${today.year}-${today.month}-${today.day}`;
      const cells = [];
      for (let index = firstWeekday; index > 0; index -= 1) {
        const date = new Date(state.viewYear, state.viewMonth - 1, 1 - index);
        cells.push({ year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate(), outside: true });
      }
      for (let day = 1; day <= daysHere; day += 1) cells.push({ year: state.viewYear, month: state.viewMonth, day, outside: false });
      while (cells.length < 42) {
        const extra = cells.length - firstWeekday - daysHere + 1;
        const date = new Date(state.viewYear, state.viewMonth, extra);
        cells.push({ year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate(), outside: true });
      }
      grid.innerHTML = cells.map((cell) => {
        const key = `${cell.year}-${cell.month}-${cell.day}`;
        const classes = ['cal-day', cell.outside ? 'outside' : '', key === selectedKey() ? 'selected' : '', key === todayKey ? 'today' : ''].filter(Boolean).join(' ');
        return `<button type="button" class="${classes}" role="gridcell" aria-pressed="${key === selectedKey()}" data-year="${cell.year}" data-month="${cell.month}" data-day="${cell.day}" aria-label="${esc(`${cell.year}-${pad(cell.month)}-${pad(cell.day)}`)}">${cell.day}</button>`;
      }).join('');
      grid.querySelectorAll('button').forEach((buttonEl) => {
        buttonEl.onclick = () => {
          state.selected.year = Number(buttonEl.dataset.year);
          state.selected.month = Number(buttonEl.dataset.month);
          state.selected.day = Number(buttonEl.dataset.day);
          state.viewYear = state.selected.year;
          state.viewMonth = state.selected.month;
          monthSelect.value = String(state.viewMonth);
          fillYears(state.viewYear);
          renderGrid();
        };
      });
    };
    const setViewMonth = (year, month) => {
      const shifted = new Date(year, month - 1, 1);
      state.viewYear = shifted.getFullYear();
      state.viewMonth = shifted.getMonth() + 1;
      monthSelect.value = String(state.viewMonth);
      fillYears(state.viewYear);
      renderGrid();
    };
    const readTime = () => {
      const hour12 = Number(hourSelect.value) || 12;
      const meridiem = meridiemSelect.value === 'PM' ? 'PM' : 'AM';
      const hour = meridiem === 'AM' ? hour12 % 12 : (hour12 % 12) + 12;
      const minute = Number(minuteSelect.value) || 0;
      return { hour, minute };
    };
    const closePicker = () => { dialog.close(); };
    const openPicker = (fieldId, label) => {
      state.fieldId = fieldId;
      title.textContent = label;
      const input = document.querySelector(`#${fieldId}`);
      const current = input?.value;
      const fallback = fieldId === 'cend' && start.value ? new Date(new Date(start.value).getTime() + 60 * 60 * 1000) : new Date();
      const source = current && !Number.isNaN(Date.parse(current)) ? new Date(current) : fallback;
      const parts = tzParts(Number.isNaN(source.valueOf()) ? new Date() : source, zone());
      if (!current) {
        parts.minute = Math.round(parts.minute / 5) * 5;
        if (parts.minute === 60) { parts.minute = 0; parts.hour = (parts.hour + 1) % 24; }
      }
      state.selected = { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour, minute: parts.minute };
      state.viewYear = parts.year;
      state.viewMonth = parts.month;
      monthSelect.value = String(parts.month);
      fillYears(parts.year);
      fillMinutes(parts.minute);
      const hour12 = parts.hour % 12 || 12;
      hourSelect.value = String(hour12);
      meridiemSelect.value = parts.hour < 12 ? 'AM' : 'PM';
      renderGrid();
      document.querySelector(`#${fieldId}-trigger`)?.setAttribute('aria-expanded', 'true');
      dialog.showModal();
    };
    document.querySelector('#cstart-trigger').onclick = () => openPicker('cstart', 'Start');
    document.querySelector('#cend-trigger').onclick = () => openPicker('cend', 'End');
    document.querySelector('#ctimezone')?.addEventListener('change', syncLabels);
    document.querySelector('#ctimezone')?.addEventListener('input', syncLabels);
    monthSelect.onchange = () => setViewMonth(state.viewYear, Number(monthSelect.value));
    yearSelect.onchange = () => setViewMonth(Number(yearSelect.value), state.viewMonth);
    dialog.querySelector('[data-datetime-prev]').onclick = () => setViewMonth(state.viewYear, state.viewMonth - 1);
    dialog.querySelector('[data-datetime-next]').onclick = () => setViewMonth(state.viewYear, state.viewMonth + 1);
    dialog.querySelector('[data-datetime-close]').onclick = closePicker;
    dialog.querySelector('[data-datetime-clear]').onclick = () => {
      const input = document.querySelector(`#${state.fieldId}`);
      if (input) input.value = '';
      syncLabels();
      closePicker();
    };
    dialog.querySelector('[data-datetime-apply]').onclick = () => {
      const time = readTime();
      const input = document.querySelector(`#${state.fieldId}`);
      if (input) input.value = wallTimeToIso(state.selected.year, state.selected.month, state.selected.day, time.hour, time.minute, zone());
      syncLabels();
      closePicker();
    };
    dialog.addEventListener('click', (event) => {
      const box = dialog.getBoundingClientRect();
      if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) closePicker();
    });
    dialog.addEventListener('close', () => {
      document.querySelectorAll('.datetime-trigger').forEach((trigger) => trigger.setAttribute('aria-expanded', 'false'));
    });
  }

  async function review(candidate) {
    if (!candidate) return;
    const kind = candidate.changeKind || 'create';
    const explanation = kind === 'cancel' ? 'Cancel removes the related calendar event after approval.' : kind === 'update' ? 'Update changes the related calendar event after approval.' : 'Create adds a new calendar event after approval.';
    setView(`<section class="card"><div class="section-head"><div><span class="tag ${esc(kind)}">${esc(kind)}</span><h2 style="margin-top:10px">${esc(candidate.title)}</h2><p class="muted">${esc(explanation)}</p></div>${button('Back', 'ghost', 'data-back')}</div><div class="notice">Check every proposed detail before approving this ${esc(kind)} request.</div><div class="form-grid"><div class="field"><label for="ctitle">Title</label><input id="ctitle" value="${esc(candidate.title)}"></div><div class="field"><label for="ccalendar">Destination calendar</label><select id="ccalendar"><option value="${esc(candidate.calendarId)}">${esc(candidate.calendarId || 'Choose a calendar')}</option></select></div>${datetimeField('cstart', 'Start', candidate.start, candidate.timezone)}${datetimeField('cend', 'End', candidate.end, candidate.timezone)}<div class="field"><label for="ctimezone">Timezone</label><input id="ctimezone" value="${esc(candidate.timezone)}"></div><div class="field"><label for="clocation">Location</label><input id="clocation" value="${esc(candidate.location)}"></div><div class="field"><label for="corganizer">Organizer</label><input id="corganizer" value="${esc(candidate.organizer)}"></div><div class="field"><label for="curl">Registration URL</label><input id="curl" type="url" value="${esc(candidate.registrationUrl)}"></div><div class="field"><label for="csource">Source email URL</label><input id="csource" type="url" value="${esc(candidate.sourceUrl)}"></div><div class="field wide"><label for="cdescription">Description</label><textarea id="cdescription" rows="5">${esc(candidate.description)}</textarea></div></div><div class="detail-grid"><div><b>Confidence</b><span>${esc(`${Math.round((Number(candidate.confidence) || 0) * 100)}%`)}</span></div><div><b>Uncertainty</b><span>${esc((candidate.uncertaintyNotes || []).join(' · ') || 'None noted')}</span></div><div><b>Sources</b><span>${esc((candidate.sourceMessageIds || []).join(', ') || 'No message IDs recorded')}</span></div><div><b>Source excerpt</b><span>${esc(candidate.sourceExcerpt || 'Not available')}</span></div></div><div class="actions section">${button(kind === 'cancel' ? 'Approve cancellation' : kind === 'update' ? 'Approve update' : 'Approve & create', 'good', 'data-approve')}${button('Deny proposal', 'danger', 'data-deny')}</div></section>`);
    document.querySelector('[data-back]').onclick = () => navigate('calendar');
    document.querySelector('[data-approve]').onclick = () => decision(candidate.id, 'approve');
    document.querySelector('[data-deny]').onclick = () => decision(candidate.id, 'deny');
    bindDatetimePickers();
    api('/api/google/calendars').then((calendars) => fillSelect('ccalendar', calendars, candidate.calendarId)).catch(() => {});
  }

  async function decision(id, action) {
    const controls = [...document.querySelectorAll('[data-approve], [data-deny]')];
    controls.forEach((element) => { element.disabled = true; });
    try {
      if (action === 'approve' && document.querySelector('#ctitle')) {
        const value = (fieldId) => document.querySelector(`#${fieldId}`).value;
        await api(`/api/candidates/${id}`, { method: 'PATCH', body: JSON.stringify({
          title: value('ctitle'), calendarId: value('ccalendar'), start: value('cstart') || null, end: value('cend') || null,
          timezone: value('ctimezone'), location: value('clocation'), organizer: value('corganizer'), registrationUrl: value('curl'), sourceUrl: value('csource'), description: value('cdescription'),
        }) });
      }
      await api(`/api/candidates/${id}/${action}`, { method: 'POST' });
      notify(action === 'approve' ? 'Calendar change approved.' : 'Proposal denied.');
      navigate('calendar');
    } catch (error) {
      controls.forEach((element) => { element.disabled = false; });
      notify(error.message, true);
    }
  }

  async function queueAction(event) {
    try { await api(`/api/queue/${event.currentTarget.dataset.queue}`, { method: 'POST' }); await dashboard(); } catch (error) { notify(error.message, true); }
  }
  async function retryFailedMessages() {
    try {
      const result = await api('/api/queue/retry-failed', { method: 'POST' });
      notify(`${count(result.retried)} failed message${count(result.retried) === 1 ? '' : 's'} returned to the queue.`);
      await dashboard();
    } catch (error) { notify(error.message, true); }
  }
  async function scanNow() {
    try { const result = await api('/api/scan/now', { method: 'POST' }); notify(`${count(result.queuedCount)} message${count(result.queuedCount) === 1 ? '' : 's'} queued for scanning.`); } catch (error) { notify(error.message, true); }
  }

  function optionMarkup(items, selected, placeholder = 'Choose an option') {
    const list = Array.isArray(items) ? items : [];
    const selectedIds = Array.isArray(selected) ? selected : [selected];
    const missing = selectedIds.filter((id) => id && !list.some((item) => item.id === id));
    return `<option value="">${esc(placeholder)}</option>${missing.map((id) => `<option value="${esc(id)}" selected>${esc(id)}</option>`).join('')}${list.map((item) => `<option value="${esc(item.id)}" ${selectedIds.includes(item.id) ? 'selected' : ''}>${esc(item.name || item.id)}${item.primary ? ' (primary)' : ''}</option>`).join('')}`;
  }
  function fillSelect(id, items, selected, placeholder) {
    const select = document.querySelector(`#${id}`);
    if (select) select.innerHTML = optionMarkup(items, selected, placeholder);
  }

  function setupCustomSelect(items, selectedId) {
    const root = document.querySelector('#calendar-select');
    if (!root) return;
    const trigger = root.querySelector('.custom-select-trigger');
    const label = trigger.querySelector('span');
    const menu = root.querySelector('.custom-select-menu');
    const input = root.querySelector('#calendar');
    const choose = (id) => {
      const selected = items.find((item) => item.id === id);
      input.value = selected?.id || '';
      label.textContent = selected ? `${selected.name || selected.id}${selected.primary ? ' (primary)' : ''}` : 'Choose a calendar';
      menu.querySelectorAll('[role="option"]').forEach((option) => option.setAttribute('aria-selected', String(option.dataset.id === input.value)));
      menu.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
    };
    menu.innerHTML = items.map((item) => `<button type="button" role="option" data-id="${esc(item.id)}" aria-selected="false"><span>${esc(item.name || item.id)}</span>${item.primary ? '<small>Primary</small>' : ''}</button>`).join('') || '<div class="custom-select-empty">No writable calendars found.</div>';
    menu.querySelectorAll('[role="option"]').forEach((option) => { option.onclick = () => choose(option.dataset.id); });
    trigger.onclick = () => {
      menu.hidden = !menu.hidden;
      trigger.setAttribute('aria-expanded', String(!menu.hidden));
      if (!menu.hidden) menu.querySelector('[aria-selected="true"]')?.focus();
    };
    root.onkeydown = (event) => {
      if (event.key === 'Escape') { menu.hidden = true; trigger.setAttribute('aria-expanded', 'false'); trigger.focus(); }
    };
    choose(selectedId);
  }

  function setupSearchSelect(rootId, items, selectedId, placeholder = 'Choose a model') {
    const root = document.querySelector(`#${rootId}`);
    if (!root) return;
    const trigger = root.querySelector('.custom-select-trigger');
    const label = trigger.querySelector('span');
    const menu = root.querySelector('.custom-select-menu');
    const options = root.querySelector('.model-options');
    const filter = root.querySelector('.model-filter');
    const input = root.querySelector('input[type="hidden"]');
    const render = (query = '') => {
      const needle = query.trim().toLowerCase();
      const list = (Array.isArray(items) ? items : []).filter((item) => !needle || `${item.name || ''} ${item.id}`.toLowerCase().includes(needle));
      options.innerHTML = list.map((item) => `<button type="button" role="option" data-id="${esc(item.id)}" aria-selected="${item.id === input.value}"><span>${esc(item.name || item.id)}</span>${item.batch ? '<small>Batch</small>' : ''}</button>`).join('') || '<div class="custom-select-empty">No matching models.</div>';
      options.querySelectorAll('[role="option"]').forEach((option) => { option.onclick = () => choose(option.dataset.id); });
    };
    const choose = (id) => {
      const selected = items.find((item) => item.id === id);
      input.value = selected?.id || '';
      label.textContent = selected ? selected.name || selected.id : placeholder;
      render(filter?.value || '');
      menu.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
      input.dispatchEvent(new Event('change', { bubbles: true }));
    };
    trigger.onclick = () => {
      menu.hidden = !menu.hidden;
      trigger.setAttribute('aria-expanded', String(!menu.hidden));
      if (!menu.hidden) { render(filter?.value || ''); filter?.focus(); }
    };
    if (filter) {
      filter.oninput = () => render(filter.value);
      filter.onclick = (event) => event.stopPropagation();
    }
    root.onkeydown = (event) => {
      if (event.key === 'Escape') { menu.hidden = true; trigger.setAttribute('aria-expanded', 'false'); trigger.focus(); }
    };
    if (filter) filter.value = '';
    render('');
    choose(selectedId);
  }

  async function loadProviderModels(provider, status) {
    if (provider === 'openrouter') return api('/api/openrouter/models').catch(() => []);
    if (!status.openaiConnected) return [];
    return api('/api/openai/models').catch(() => []);
  }

  function modelSelectMarkup(id, hiddenId, placeholder) {
    return `<div id="${id}" class="custom-select"><button type="button" class="custom-select-trigger" aria-haspopup="listbox" aria-expanded="false"><span>${esc(placeholder)}</span><b aria-hidden="true">⌄</b></button><div class="custom-select-menu" role="listbox" hidden><input class="model-filter" type="search" placeholder="Search models" autocomplete="off"><div class="model-options"></div></div><input id="${hiddenId}" name="${hiddenId}" type="hidden"></div>`;
  }

  async function settings() {
    const [saved, status] = await Promise.all([api('/api/settings'), api('/api/dashboard')]);
    const provider = saved.modelProvider === 'openrouter' ? 'openrouter' : 'openai-codex';
    let models = [];
    const [labels, calendars, loadedModels] = await Promise.all([
      status.googleConnected ? api('/api/google/labels').catch(() => []) : Promise.resolve([]),
      status.googleConnected ? api('/api/google/calendars').catch(() => []) : Promise.resolve([]),
      loadProviderModels(provider, status),
    ]);
    models = loadedModels;
    setView(`<section class="card"><div class="section-head"><div><h2>Workspace settings</h2><p class="muted">Choose sources, scheduling, and the model used to prepare proposals.</p></div></div><form id="settings-form"><div class="form-grid"><div class="field"><label for="scanTime">Daily scan time</label><input id="scanTime" name="scanTime" type="time" value="${esc(saved.scanTime)}"></div><div class="field"><label for="timezone">Timezone</label><input id="timezone" name="timezone" value="${esc(saved.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone)}"></div><div class="field"><label for="gmailLabelIds">Gmail labels</label><select id="gmailLabelIds" name="gmailLabelIds" multiple ${status.googleConnected ? '' : 'disabled'}>${optionMarkup(labels, saved.gmailLabelIds, status.googleConnected ? 'No label selected' : 'Connect Google first')}</select><small class="muted">Use Ctrl/Cmd to select multiple labels.</small></div><div class="field"><label for="calendarId">Destination calendar</label><select id="calendarId" name="calendarId" ${status.googleConnected ? '' : 'disabled'}>${optionMarkup(calendars, saved.calendarId, status.googleConnected ? 'Choose a calendar' : 'Connect Google first')}</select></div><div class="field wide"><span class="field-label">Model provider</span><div class="provider-toggle" role="radiogroup" aria-label="Model provider"><label class="choice"><input type="radio" name="modelProvider" value="openai-codex" ${provider === 'openai-codex' ? 'checked' : ''}><span>OpenAI Codex ${status.openaiConnected ? '(connected)' : '(not connected)'}</span></label><label class="choice"><input type="radio" name="modelProvider" value="openrouter" ${provider === 'openrouter' ? 'checked' : ''}><span>OpenRouter ${status.openrouterConnected ? '(connected)' : '(not connected)'}</span></label></div><small class="muted">OpenRouter uses its own API key and does not replace a Codex login.</small></div><div id="codex-login-field" class="field wide" ${provider === 'openai-codex' ? '' : 'hidden'}><span class="field-label">Codex sign-in</span><div class="actions"><button type="button" class="button primary" data-settings-oai="browser">${status.openaiConnected ? 'Sign in again in browser' : 'Sign in in browser'}</button><button type="button" class="button ghost" data-settings-oai="device_code">Use device code</button></div><div id="settings-oauth-note" aria-live="polite"></div></div><div id="openrouter-key-field" class="field wide" ${provider === 'openrouter' ? '' : 'hidden'}><label for="openrouterKey">OpenRouter API key</label><div class="key-row"><input id="openrouterKey" type="password" autocomplete="new-password" spellcheck="false" placeholder="${status.openrouterConnected ? 'Saved · enter a new key to replace it' : 'sk-or-v1-...'}"><button type="button" class="button" data-or-save>Save key</button></div></div><div class="field"><label>Model</label>${modelSelectMarkup('model-select', 'modelId', 'Choose a model')}</div><div class="field"><label for="reasoningLevel">Reasoning level</label><select id="reasoningLevel" name="reasoningLevel"></select></div><div class="field wide"><label for="interests">Interests & context</label><textarea id="interests" name="interests" rows="4">${esc(saved.interests)}</textarea></div><div class="field wide"><label for="filterRules">Filter rules</label><textarea id="filterRules" name="filterRules" rows="4" placeholder="Describe emails or events to ignore.">${esc(saved.filterRules)}</textarea></div><div class="field wide"><label for="schoolImportRules">School import rules</label><textarea id="schoolImportRules" name="schoolImportRules" rows="4" placeholder="How school imports should be interpreted or filtered">${esc(saved.schoolImportRules)}</textarea></div><div class="field"><label><input id="scanPaused" name="scanPaused" type="checkbox" ${saved.scanPaused ? 'checked' : ''}> Pause queue processing</label></div></div>${button('Save settings', 'primary', 'type="submit"')}</form></section>`);
    const selectedProvider = () => document.querySelector('input[name="modelProvider"]:checked')?.value || 'openai-codex';
    const updateReasoning = () => {
      const model = models.find((item) => item.id === document.querySelector('#modelId').value);
      const levels = model?.reasoningLevels?.length ? model.reasoningLevels : ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
      fillSelect('reasoningLevel', levels.map((level) => ({ id: level, name: level })), saved.reasoningLevel, 'Choose a level');
    };
    const refreshModels = async () => {
      const current = selectedProvider();
      const keyField = document.querySelector('#openrouter-key-field');
      const codexField = document.querySelector('#codex-login-field');
      if (keyField) keyField.hidden = current !== 'openrouter';
      if (codexField) codexField.hidden = current !== 'openai-codex';
      models = await loadProviderModels(current, status);
      setupSearchSelect('model-select', models, saved.modelId, models.length ? 'Choose a model' : 'Connect this provider to load models');
      updateReasoning();
    };
    await refreshModels();
    document.querySelectorAll('input[name="modelProvider"]').forEach((input) => { input.onchange = () => { void refreshModels(); }; });
    document.querySelector('#modelId')?.addEventListener('change', updateReasoning);
    const inspectCodexLogin = async () => {
      const login = await api('/api/openai/login');
      const note = document.querySelector('#settings-oauth-note');
      if (note) note.innerHTML = authEvents(login.events, login.state, login.error);
      if (login.state === 'connected') { status.openaiConnected = true; clearInterval(loginPoller); await refreshModels(); }
      if (login.state === 'failed') clearInterval(loginPoller);
    };
    document.querySelectorAll('[data-settings-oai]').forEach((element) => {
      element.onclick = async () => {
        try {
          const login = await api('/api/openai/login', { method: 'POST', body: JSON.stringify({ method: element.dataset.settingsOai }) });
          const note = document.querySelector('#settings-oauth-note');
          if (note) note.innerHTML = authEvents(login.events, login.state, login.error);
          clearInterval(loginPoller);
          if (login.state === 'connected') { status.openaiConnected = true; await refreshModels(); }
          else loginPoller = setInterval(() => inspectCodexLogin().catch((error) => { if (note) note.innerHTML = authEvents([], 'failed', error.message); clearInterval(loginPoller); }), 2000);
        } catch (error) { notify(error.message, true); }
      };
    });
    document.querySelector('[data-or-save]')?.addEventListener('click', async () => {
      try {
        await api('/api/openrouter/login', { method: 'POST', body: JSON.stringify({ apiKey: document.querySelector('#openrouterKey').value }) });
        status.openrouterConnected = true;
        notify('OpenRouter API key saved. Codex login is unchanged.');
        await refreshModels();
      } catch (error) { notify(error.message, true); }
    });
    document.querySelector('#settings-form').onsubmit = async (event) => {
      event.preventDefault();
      try {
        const form = event.currentTarget;
        const payload = {
          scanTime: form.scanTime.value, timezone: form.timezone.value,
          gmailLabelIds: Array.from(form.gmailLabelIds.selectedOptions).map((option) => option.value).filter(Boolean),
          calendarId: form.calendarId.value, modelProvider: selectedProvider(), modelId: form.modelId.value, reasoningLevel: form.reasoningLevel.value,
          interests: form.interests.value, filterRules: form.filterRules.value, schoolImportRules: form.schoolImportRules.value, scanPaused: form.scanPaused.checked,
        };
        await api('/api/settings', { method: 'PATCH', body: JSON.stringify(payload) });
        notify('Settings saved.');
      } catch (error) { notify(error.message, true); }
    };
  }

  function auth(setup) {
    app.innerHTML = `<div class="auth card"><div class="brand"><i>✦</i> School Manager</div><h1>${setup ? 'Create your secure workspace' : 'Welcome back'}</h1><p class="sub">${setup ? 'Create a password to protect your connected accounts.' : 'Sign in to manage classes, assignments, and calendar proposals.'}</p><form id="authform"><div class="field"><label for="password">Password</label><input id="password" type="password" minlength="12" required autocomplete="${setup ? 'new-password' : 'current-password'}" placeholder="At least 12 characters"></div>${button(setup ? 'Continue setup' : 'Sign in', 'primary', 'type="submit"')}</form></div>`;
    document.querySelector('#authform').onsubmit = async (event) => {
      event.preventDefault();
      try {
        const result = await api(`/api/auth/${setup ? 'setup' : 'login'}`, { method: 'POST', body: JSON.stringify({ password: document.querySelector('#password').value }) });
        csrf = result.csrfToken || csrf;
        if (setup) wizard(1); else openWorkspace();
      } catch (error) { notify(error.message, true); }
    };
  }

  async function wizardForStatus(status) {
    if (!status.googleConnected) return wizard(1);
    if (!status.openaiConnected && !status.openrouterConnected) return wizard(2);
    return wizard(4);
  }

  async function wizard(step) {
    clearInterval(loginPoller);
    scanRunId = null;
    let saved = {};
    try { saved = await api('/api/settings'); } catch { /* Wizard can still show its connection step. */ }
    const googleCallbackUrl = boot.googleCallbackUrl || `${location.origin}/api/google/callback`;
    const pages = {
      1: `<h1>Connect Google</h1><p class="sub">Upload your OAuth client credentials, then authorize Gmail and Calendar access.</p><p class="setup-help"><a href="https://console.cloud.google.com/apis/credentials/oauthclient" target="_blank" rel="noopener noreferrer">Create a Google OAuth client ↗</a></p><div class="oauth-guide"><div><span>Application type</span><strong>Web application</strong></div><div><span>Name</span><strong>School Manager</strong></div><div><span>Authorized JavaScript origins</span><strong>Leave empty</strong></div><div class="wide"><span>Authorized redirect URI</span><code>${esc(googleCallbackUrl)}</code></div></div><p class="setup-note">If Google asks for a consent screen, choose <strong>External</strong>, keep it in testing, and add your Google account as a test user.</p><div class="file"><div class="file-copy"><span class="file-title">Google OAuth client JSON</span><span id="client-name" class="file-name">No file selected</span></div><label class="button ghost file-picker" for="client">Choose file</label><input id="client" class="visually-hidden" type="file" accept="application/json,.json"></div><div class="actions section">${button('Upload credentials', 'ghost', 'data-upload')}${button('Connect Google', 'primary', 'data-connect')}</div>`,
      2: `<h1>Choose sources</h1><p class="sub">Select one or more Gmail labels and the calendar where approved events belong.</p><div class="form-grid source-grid"><div class="field"><span class="field-label">Gmail labels</span><div id="label" class="choice-list" role="group" aria-label="Gmail labels"></div></div><div class="field"><label for="calendar-trigger">Destination calendar</label><div id="calendar-select" class="custom-select"><button id="calendar-trigger" class="custom-select-trigger" type="button" aria-haspopup="listbox" aria-expanded="false"><span>Choose a calendar</span><b aria-hidden="true">⌄</b></button><div class="custom-select-menu" role="listbox" hidden></div><input id="calendar" type="hidden"></div></div></div>`,
      3: `<h1>Connect a model provider</h1><p class="sub">Use a ChatGPT subscription or an OpenRouter API key. Each login is stored separately, so connecting OpenRouter does not replace Codex.</p><div class="provider-toggle" role="radiogroup" aria-label="Model provider"><label class="choice"><input type="radio" name="modelProvider" value="openai-codex" ${saved.modelProvider !== 'openrouter' ? 'checked' : ''}><span>OpenAI Codex</span></label><label class="choice"><input type="radio" name="modelProvider" value="openrouter" ${saved.modelProvider === 'openrouter' ? 'checked' : ''}><span>OpenRouter</span></label></div><div id="codex-pane"><div class="actions">${button('Sign in in browser', 'primary', 'data-oai="browser"')}${button('Use device code', 'ghost', 'data-oai="device_code"')}</div><div id="oauth-note" class="section" aria-live="polite"></div></div><div id="openrouter-pane" hidden><div class="field"><label for="openrouterKey">OpenRouter API key</label><input id="openrouterKey" type="password" autocomplete="off" placeholder="sk-or-v1-..."></div><div class="actions">${button('Save API key', 'primary', 'data-or-login')}</div><div id="or-note" class="section" aria-live="polite"></div></div><div class="form-grid section"><div class="field"><label>Model</label>${modelSelectMarkup('model-select', 'model', 'Connect a provider to load models')}</div><div class="field"><label for="reasoning">Reasoning level</label><select id="reasoning"></select></div></div>`,
      4: `<h1>Tailor your assistant</h1><p class="sub">Set a daily scan time and context so suggestions match your working style.</p><div class="form-grid"><div class="field"><label for="scanTime">Daily scan time</label><input id="scanTime" type="time" value="${esc(saved.scanTime || '09:00')}"></div><div class="field"><label for="timezone">Timezone</label><input id="timezone" value="${esc(saved.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone)}"></div><div class="field wide"><label for="interests">Interests & context</label><textarea id="interests" rows="4">${esc(saved.interests || '')}</textarea></div><div class="field wide"><label for="filterRules">Filter rules</label><textarea id="filterRules" rows="4">${esc(saved.filterRules || '')}</textarea></div></div>`,
      5: `<h1>Initial inbox scan</h1><p class="sub">We’ll count messages in your chosen labels before any processing begins.</p><div id="count" class="notice">Counting eligible messages…</div><div id="initial-progress" class="scan-progress" hidden><div class="progress-label"><strong>Processing email</strong><span id="initial-progress-count">0 of 0</span></div><div class="progress" role="progressbar" aria-label="Initial scan progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span style="width:0%"></span></div><p id="initial-progress-detail" class="muted">Starting three parallel workers…</p></div>`,
    };
    app.innerHTML = `<div class="wizard card"><div class="brand"><i>✦</i> School Manager</div><div class="steps">${['Google', 'Sources', 'Model', 'Preferences', 'Scan'].map((label, index) => `<div class="step ${index + 1 === step ? 'active' : index + 1 < step ? 'done' : ''}"><b>${index + 1}</b>${label}</div>`).join('')}</div><div class="wizard-page active">${pages[step]}</div><div class="wizard-footer">${step > 1 ? button('Back', 'ghost', 'data-prev') : ''}<span></span>${step < 5 ? button('Continue', 'primary', 'data-next') : button('Confirm & start scan', 'primary', 'data-finish')}</div></div>`;
    document.querySelector('[data-prev]')?.addEventListener('click', () => wizard(step - 1));
    document.querySelector('[data-next]')?.addEventListener('click', async () => {
      try {
        if (step === 1) {
          const status = await api('/api/dashboard');
          if (!status.googleConnected) throw new Error('Connect Google before continuing.');
        }
        if (step === 2) {
          const gmailLabelIds = Array.from(document.querySelectorAll('#label input:checked')).map((input) => input.value);
          const calendarId = document.querySelector('#calendar').value;
          if (!gmailLabelIds.length || !calendarId) throw new Error('Choose at least one Gmail label and a calendar.');
          await api('/api/settings', { method: 'PATCH', body: JSON.stringify({ gmailLabelIds, calendarId }) });
        }
        if (step === 3) {
          const modelProvider = document.querySelector('input[name="modelProvider"]:checked')?.value || 'openai-codex';
          const modelId = document.querySelector('#model').value;
          const reasoningLevel = document.querySelector('#reasoning').value;
          if (!modelId) throw new Error('Wait for a provider to connect, then choose a model.');
          const status = await api('/api/dashboard');
          if (modelProvider === 'openrouter' && !status.openrouterConnected) throw new Error('Save an OpenRouter API key first.');
          if (modelProvider !== 'openrouter' && !status.openaiConnected) throw new Error('Connect OpenAI Codex first.');
          await api('/api/settings', { method: 'PATCH', body: JSON.stringify({ modelProvider, modelId, reasoningLevel }) });
        }
        if (step === 4) await api('/api/settings', { method: 'PATCH', body: JSON.stringify({ scanTime: document.querySelector('#scanTime').value, timezone: document.querySelector('#timezone').value, interests: document.querySelector('#interests').value, filterRules: document.querySelector('#filterRules').value }) });
        wizard(step + 1);
      } catch (error) { notify(error.message, true); }
    });
    document.querySelector('[data-finish]')?.addEventListener('click', async (event) => {
      if (event.currentTarget.dataset.complete === 'true') { navigate('dashboard'); return; }
      try {
        if (!scanRunId) throw new Error('Waiting for the message count.');
        event.currentTarget.disabled = true;
        event.currentTarget.textContent = 'Starting scan…';
        const result = await api('/api/scan/confirm', { method: 'POST', body: JSON.stringify({ runId: scanRunId }) });
        watchInitialScan(count(result.queuedCount), event.currentTarget);
      } catch (error) { event.currentTarget.disabled = false; event.currentTarget.textContent = 'Confirm & start scan'; notify(error.message, true); }
    });
    bindWizardStep(step, saved);
  }

  function bindWizardStep(step, saved) {
    if (step === 1) {
      document.querySelector('#client')?.addEventListener('change', (event) => {
        const name = event.target.files[0]?.name || 'No file selected';
        document.querySelector('#client-name').textContent = name;
      });
      document.querySelector('[data-upload]')?.addEventListener('click', async () => {
        const file = document.querySelector('#client').files[0];
        if (!file) return notify('Choose your client JSON first.', true);
        try { const body = new FormData(); body.append('client', file); await api('/api/google/client', { method: 'POST', body }); notify('Credentials uploaded. Now connect Google.'); } catch (error) { notify(error.message, true); }
      });
      document.querySelector('[data-connect]')?.addEventListener('click', async () => {
        try { const result = await api('/api/google/connect'); location.href = result.url; } catch (error) { notify(error.message, true); }
      });
    }
    if (step === 2) Promise.all([api('/api/google/labels'), api('/api/google/calendars')]).then(([labels, calendars]) => {
      const selected = new Set(saved.gmailLabelIds || []);
      document.querySelector('#label').innerHTML = labels.map((label) => `<label class="choice"><input type="checkbox" value="${esc(label.id)}" ${selected.has(label.id) ? 'checked' : ''}><span>${esc(label.name || label.id)}</span></label>`).join('') || '<span class="muted">No labels found.</span>';
      setupCustomSelect(calendars, saved.calendarId);
    }).catch((error) => notify(error.message, true));
    if (step === 3) setupModelStep(saved);
    if (step === 5) Promise.all([api('/api/scan/count', { method: 'POST' }), api('/api/queue')]).then(([result, queue]) => {
      scanRunId = result.runId;
      scanBaseline = count(queue.processed) + count(queue.failed);
      const message = document.querySelector('#count');
      if (message) message.textContent = `${count(result.messageCount)} eligible messages found. Confirm to begin the initial scan.`;
    }).catch((error) => { const message = document.querySelector('#count'); if (message) message.textContent = error.message; });
  }

  function watchInitialScan(total, finishButton) {
    const panel = document.querySelector('#initial-progress');
    const bar = panel?.querySelector('.progress');
    const fill = bar?.querySelector('span');
    const label = document.querySelector('#initial-progress-count');
    const detail = document.querySelector('#initial-progress-detail');
    const countNotice = document.querySelector('#count');
    const back = document.querySelector('[data-prev]');
    if (!panel || !bar || !fill || !label || !detail) return;
    panel.hidden = false;
    if (countNotice) countNotice.hidden = true;
    if (back) back.disabled = true;
    let started = total === 0;
    const update = async () => {
      try {
        const queue = await api('/api/queue');
        const completed = Math.max(0, count(queue.processed) + count(queue.failed) - scanBaseline);
        const remaining = count(queue.queued) + count(queue.processing);
        if (remaining + completed > 0) started = true;
        const percent = total ? Math.min(100, Math.round((completed / total) * 100)) : 100;
        label.textContent = `${Math.min(completed, total || completed)} of ${total}`;
        fill.style.width = `${percent}%`;
        bar.setAttribute('aria-valuenow', String(percent));
        const dashboard = await api('/api/dashboard').catch(() => ({}));
        const queueLine = queue.batchMessage
          || (queue.paused
            ? `Paused · ${count(queue.queued)} queued · ${count(queue.processing)} processing`
            : count(queue.processing) === 0 && count(queue.queued) > 0 && completed === 0
              ? `Collecting message IDs from Gmail… ${count(queue.queued)} queued`
              : `${count(queue.processing)} processing · ${count(queue.queued)} queued${count(queue.failed) ? ` · ${count(queue.failed)} failed` : ''}`);
        detail.textContent = dashboard.lastError ? `${queueLine}. ${dashboard.lastError}` : queueLine;
        if (started && remaining === 0) {
          clearInterval(poller);
          detail.textContent = count(queue.failed) ? 'Scan finished with errors. Review the queue from the dashboard.' : 'Initial scan complete.';
          fill.style.width = '100%';
          bar.setAttribute('aria-valuenow', '100');
          finishButton.disabled = false;
          finishButton.dataset.complete = 'true';
          finishButton.textContent = 'Open dashboard';
          if (back) back.disabled = false;
        }
      } catch (error) { detail.textContent = error.message; }
    };
    clearInterval(poller);
    void update();
    poller = setInterval(update, 1000);
  }

  function authEvents(events, state, error) {
    const lines = (events || []).map((event) => {
      if (event.type === 'auth_url') return `<div class="notice">${esc(event.instructions || 'Continue authentication in your browser.')}<br><a href="${esc(event.url)}" target="_blank" rel="noopener">Open authorization page</a></div>`;
      if (event.type === 'device_code') return `<div class="notice">Go to <a href="${esc(event.verificationUri)}" target="_blank" rel="noopener">${esc(event.verificationUri)}</a> and enter code <b>${esc(event.userCode)}</b>.</div>`;
      return `<p class="muted">${esc(event.message || '')}</p>`;
    }).join('');
    const emptyState = state === 'connected' ? '' : `<p class="muted">${state === 'running' ? 'Preparing OpenAI sign-in…' : 'Choose a sign-in method.'}</p>`;
    return `${lines || emptyState}${error ? `<div class="notice error">${esc(error)}</div>` : ''}${state === 'connected' ? '<div class="notice">OpenAI connected. Models are ready to choose.</div>' : ''}`;
  }

  async function setupModelStep(saved) {
    const note = document.querySelector('#oauth-note');
    const orNote = document.querySelector('#or-note');
    const dashboardStatus = await api('/api/dashboard').catch(() => ({ openaiConnected: false, openrouterConnected: false }));
    let models = [];
    const selectedProvider = () => document.querySelector('input[name="modelProvider"]:checked')?.value || 'openai-codex';
    const showProvider = (provider) => {
      const codexPane = document.querySelector('#codex-pane');
      const orPane = document.querySelector('#openrouter-pane');
      if (codexPane) codexPane.hidden = provider !== 'openai-codex';
      if (orPane) orPane.hidden = provider !== 'openrouter';
    };
    const updateReasoning = () => {
      const selected = models.find((model) => model.id === document.querySelector('#model')?.value);
      const levels = selected?.reasoningLevels?.length ? selected.reasoningLevels : ['off'];
      fillSelect('reasoning', levels.map((level) => ({ id: level, name: level })), saved.reasoningLevel, 'Choose a level');
    };
    const populateModels = async () => {
      models = await loadProviderModels(selectedProvider(), dashboardStatus);
      setupSearchSelect('model-select', models, saved.modelId, models.length ? 'Choose a model' : 'Connect a provider to load models');
      const modelInput = document.querySelector('#model');
      if (modelInput) modelInput.onchange = updateReasoning;
      updateReasoning();
    };
    const inspect = async () => {
      const status = await api('/api/openai/login');
      if (note) note.innerHTML = authEvents(status.events, status.state, status.error);
      if (status.state === 'connected') { dashboardStatus.openaiConnected = true; clearInterval(loginPoller); await populateModels(); }
      if (status.state === 'failed') clearInterval(loginPoller);
    };
    showProvider(selectedProvider());
    document.querySelectorAll('input[name="modelProvider"]').forEach((input) => {
      input.onchange = () => { showProvider(input.value); void populateModels(); };
    });
    try {
      await inspect();
      if (dashboardStatus.openaiConnected || dashboardStatus.openrouterConnected) await populateModels();
    } catch { /* Login is optional until the user starts it. */ }
    if (orNote && dashboardStatus.openrouterConnected) orNote.innerHTML = '<div class="notice">OpenRouter API key saved. Codex login is unchanged.</div>';
    document.querySelectorAll('[data-oai]').forEach((element) => {
      element.onclick = async () => {
        try {
          const status = await api('/api/openai/login', { method: 'POST', body: JSON.stringify({ method: element.dataset.oai }) });
          if (note) note.innerHTML = authEvents(status.events, status.state, status.error);
          clearInterval(loginPoller);
          if (status.state === 'connected') { dashboardStatus.openaiConnected = true; await populateModels(); }
          else loginPoller = setInterval(() => inspect().catch((error) => { if (note) note.innerHTML = authEvents([], 'failed', error.message); clearInterval(loginPoller); }), 2000);
        } catch (error) { notify(error.message, true); }
      };
    });
    document.querySelector('[data-or-login]')?.addEventListener('click', async () => {
      try {
        await api('/api/openrouter/login', { method: 'POST', body: JSON.stringify({ apiKey: document.querySelector('#openrouterKey').value }) });
        dashboardStatus.openrouterConnected = true;
        if (orNote) orNote.innerHTML = '<div class="notice">OpenRouter API key saved. Codex login is unchanged.</div>';
        await populateModels();
      } catch (error) { notify(error.message, true); }
    });
  }

  /* School manager workspace */
  let schoolData = { terms: [], classes: [], assignments: [] };
  let schoolTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  let calendarTimezoneInitialized = false;
  let calendarMode = 'list', calendarView = 'month', calendarCursor = new Date(), selectedTermId = null;
  const zonedParts = (d) => Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: schoolTimezone, year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(d).filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)]));
  const localDay = (d = new Date(), configured = false) => { const x = new Date(d); if (!configured) return new Date(x.getFullYear(), x.getMonth(), x.getDate()); const p = zonedParts(x); return new Date(p.year, p.month - 1, p.day); };
  const dueDate = (a) => a.due ? new Date(a.due) : null;
  const dateKey = (d, configured = false) => { const x = configured ? localDay(d, true) : new Date(d); return `${x.getFullYear()}-${String(x.getMonth()+1).padStart(2,'0')}-${String(x.getDate()).padStart(2,'0')}`; };
  const activeTerm = () => schoolData.terms.find(t => t.status === 'active') || schoolData.terms[0];
  const classFor = id => schoolData.classes.find(c => String(c.id) === String(id));
  const openAssignments = () => { const term = activeTerm(); const classIds = new Set(schoolData.classes.filter(c => !term || String(c.termId) === String(term.id)).map(c => String(c.id))); return schoolData.assignments.filter(a => a.status !== 'done' && classIds.has(String(a.classId))); };
  function shell(view) {
    const titles = { dashboard: 'Dashboard', classes: 'Classes', calendar: 'Calendar review', documents: 'Documents', agent: 'Agent', settings: 'Settings' };
    const nav = [['dashboard','Dashboard'],['classes','Classes'],['calendar','Calendar review'],['documents','Documents'],['agent','Agent'],['settings','Settings']];
    const links = nav.map(([id,label]) => `<button class="${view===id?'active':''}" data-view="${id}">${label}${id==='calendar'?'<span class="nav-badge" data-nav-badge hidden></span>':''}</button>`).join('');
    return `<div class="shell"><aside class="sidebar"><div class="brand"><i>✦</i> School Manager</div><nav>${links}</nav><div class="side-foot">${button('Sign out','ghost','data-action="logout"')}</div></aside><section class="content"><header class="topbar"><div><div class="eyebrow">Plan your term</div><h1>${titles[view]}</h1></div></header><div id="view"><div class="loading"><span class="spinner"></span></div></div></section><nav class="mobile-nav">${links}</nav></div>`;
  }
  function bindShell() { document.querySelectorAll('[data-view]').forEach(e => e.onclick=()=>navigate(e.dataset.view)); document.querySelector('[data-action="logout"]')?.addEventListener('click',async()=>{try{await api('/api/auth/logout',{method:'POST'});location.reload();}catch(e){notify(e.message,true);}}); }
  async function loadSchool() { const [data, settings] = await Promise.all([api('/api/school/dashboard'), api('/api/settings')]); schoolData = data; schoolTimezone = resolvedZone(settings.timezone); if (!calendarTimezoneInitialized) { calendarCursor = localDay(new Date(), true); calendarTimezoneInitialized = true; } schoolData.terms ||= []; schoolData.classes ||= []; schoolData.assignments ||= []; return schoolData; }
  async function navigate(view) { current=view; clearInterval(poller); app.innerHTML=shell(view); bindShell(); try { if(view==='dashboard') await schoolDashboard(); if(view==='classes') await classesPage(); if(view==='calendar') await calendarReview(); if(view==='documents') await documentsPage(); if(view==='agent') await agentPage(); if(view==='settings') await settings(); } catch(e) { setView(`<div class="card notice error">${esc(e.message)}</div>`); } }
  function warningLabel(minutes) { const n=Number(minutes)||0; return n >= 60 ? `${Math.floor(n / 60)}h${n % 60 ? ` ${n % 60}m` : ''} warning` : `${n}m warning`; }
  function assignmentRow(a, showClass=true) { const c=classFor(a.classId); const due=dueDate(a); return `<div class="work-row"><div><strong>${esc(a.title)}</strong>${showClass&&c?` <span class="muted">· ${esc(c.name)}</span>`:''}<small>${due?esc(due.toLocaleString(undefined,{timeZone:schoolTimezone})):'Unscheduled'}${a.type?` · ${esc(a.type)}`:''}${a.warningMinutes?` · ${esc(warningLabel(a.warningMinutes))}`:''}${a.usefulLink?` · ${safeLink(a.usefulLink)}`:''}</small></div><div class="actions">${button('Edit','ghost',`data-edit-work="${esc(a.id)}"`)}${button(a.status==='done'?'Undo':'Done',a.status==='done'?'ghost':'good',`data-complete="${esc(a.id)}" data-state="${esc(a.status)}"`)}</div></div>`; }
  function bindCompletion() { document.querySelectorAll('[data-complete]').forEach(b=>b.onclick=async()=>{try{await api(`/api/assignments/${b.dataset.complete}/${b.dataset.state==='done'?'reopen':'complete'}`,{method:'POST'}); await navigate(current);}catch(e){notify(e.message,true);}}); document.querySelectorAll('[data-edit-work]').forEach(b=>b.onclick=()=>assignmentForm(schoolData.assignments.find(a=>String(a.id)===b.dataset.editWork))); }
  /** Renders the active term with classes and upcoming work side by side. */
  async function schoolDashboard() {
    await loadSchool();
    const term = activeTerm();
    const today = localDay(new Date(), true);
    const week = new Date(today);
    week.setDate(today.getDate() + 7);
    const classes = schoolData.classes.filter(c => term && String(c.termId) === String(term.id));
    const open = openAssignments();
    const upcoming = open.filter(a => dueDate(a)).sort((a, b) => dueDate(a) - dueDate(b));
    const overdue = upcoming.filter(a => dueDate(a) < new Date());
    const groups = { Today: [], Tomorrow: [] };

    for (let i = 2; i <= 7; i += 1) groups[new Date(today.getTime() + i * 86400000).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })] = [];
    upcoming.filter(a => !overdue.includes(a)).forEach(a => {
      const due = localDay(dueDate(a), true);
      const key = due.getTime() === today.getTime() ? 'Today' : due.getTime() === today.getTime() + 86400000 ? 'Tomorrow' : due.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
      if (groups[key]) groups[key].push(a);
    });

    const cards = classes.map(c => {
      const work = open.filter(a => String(a.classId) === String(c.id));
      const next = work.filter(a => dueDate(a)).sort((a, b) => dueDate(a) - dueDate(b))[0];
      const dueThisWeek = work.filter(a => {
        const due = dueDate(a);
        const day = due && localDay(due, true);
        return day && day >= today && day < week;
      }).length;
      return `<article class="card class-card"><h2>${esc(c.name)}</h2><p>${esc(c.instructor || 'Instructor TBD')}</p><strong>${next ? esc(next.title) : 'No upcoming assignment'}</strong><small>${next && dueDate(next) ? esc(dueDate(next).toLocaleString(undefined, { timeZone: schoolTimezone })) : ''} · ${dueThisWeek} due this week</small><button class="text-button" data-class="${esc(c.id)}">Open class</button></article>`;
    }).join('') || '<div class="empty">Add a class to start planning this term.</div>';
    const list = Object.entries(groups).map(([day, assignments]) => assignments.length
      ? `<section class="upcoming-group"><h3>${esc(day)}</h3>${assignments.map(a => `<div class="upcoming-assignment">${assignmentRow(a)}</div>`).join('')}</section>`
      : '').join('') || '<div class="empty">No upcoming work in the next week.</div>';

    const overdueSection = overdue.length ? `<section class="card overdue-panel"><div class="dashboard-panel-heading"><div><h2>Overdue</h2><p>${overdue.length} assignment${overdue.length===1?'':'s'} need attention</p></div></div>${overdue.map(a=>`<div class="overdue-assignment">${assignmentRow(a)}</div>`).join('')}</section>` : '';
    setView(`<div class="section-head"><div><h2>${esc(term?.name || 'No active term')}</h2><p class="muted">Your active term at a glance.</p></div><div class="actions">${button(calendarMode === 'list' ? 'Calendar' : 'List', 'ghost', 'data-calendar-toggle')}${button('New assignment', 'primary', 'data-new-assignment')}</div></div>${overdueSection}${calendarMode === 'calendar' ? renderAssignmentCalendar() : `<div class="dashboard-layout"><section class="classes-panel"><div class="dashboard-panel-heading"><h2>Classes</h2><span>${classes.length}</span></div><div class="class-cards">${cards}</div></section><aside class="card upcoming-panel"><div class="dashboard-panel-heading"><div><h2>Upcoming</h2><p>Next 7 days</p></div></div><div class="upcoming-list">${list}</div></aside></div>`}`);
    document.querySelector('[data-calendar-toggle]').onclick = () => { calendarMode = calendarMode === 'list' ? 'calendar' : 'list'; schoolDashboard(); };
    document.querySelectorAll('[data-class]').forEach(b => b.onclick = () => classDetail(b.dataset.class));
    document.querySelector('[data-new-assignment]')?.addEventListener('click', () => schoolData.classes.length ? assignmentForm() : notify('Create a term and class first.', true));
    bindCompletion();
    if (calendarMode === 'calendar') bindCalendar();
  }
  function warningSegments(d, assignments) { return assignments.filter(a=>{ const due=dueDate(a), warning=Number(a.warningMinutes)||0; if(!warning) return false; const start=new Date(due.getTime()-warning*60000); return dateKey(d)>=dateKey(start,true) && dateKey(d)<=dateKey(due,true); }).map(a=>`<span class="warning-segment" title="Warning window for ${esc(a.title)}"></span>`).join(''); }
  function renderAssignmentCalendar() { const year=calendarCursor.getFullYear(), month=calendarCursor.getMonth(); const assignments=openAssignments().filter(a=>dueDate(a)); const day=(d, outside=false)=>{const rows=assignments.filter(a=>dateKey(dueDate(a),true)===dateKey(d));return `<div class="day-cell ${outside?'outside':''}"><span>${d.getDate()}</span>${warningSegments(d,assignments)}${rows.map(calendarMark).join('')}</div>`;}; if(calendarView==='week'){const start=localDay(calendarCursor);start.setDate(start.getDate()-start.getDay());return `<section class="card"><div class="section-head"><h2>Week of ${esc(start.toLocaleDateString())}</h2><div class="actions">${button('‹','ghost','data-cal-prev')}${button('Month','ghost','data-cal-view')}${button('›','ghost','data-cal-next')}</div></div><div class="assignment-week">${Array.from({length:7},(_,i)=>{let d=new Date(start);d.setDate(start.getDate()+i);return `<div><b>${esc(d.toLocaleDateString(undefined,{weekday:'short',day:'numeric'}))}</b>${warningSegments(d,assignments)}${assignments.filter(a=>dateKey(dueDate(a),true)===dateKey(d)).map(calendarMark).join('')}</div>`;}).join('')}</div></section>`;} const first=new Date(year,month,1), start=new Date(year,month,1-first.getDay());return `<section class="card"><div class="section-head"><h2>${esc(first.toLocaleDateString(undefined,{month:'long',year:'numeric'}))}</h2><div class="actions">${button('‹','ghost','data-cal-prev')}${button('Week','ghost','data-cal-view')}${button('›','ghost','data-cal-next')}</div></div><div class="assignment-month">${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(x=>`<b>${x}</b>`).join('')}${Array.from({length:42},(_,i)=>{let d=new Date(start);d.setDate(start.getDate()+i);return day(d,d.getMonth()!==month);}).join('')}</div></section>`; }
  function calendarMark(a){const time=dueDate(a)?.toLocaleTimeString(undefined,{timeZone:schoolTimezone,hour:'numeric',minute:'2-digit'});return `<button class="due-mark" data-edit-assignment="${esc(a.id)}" title="${esc(a.title)}">${esc(a.title)}${time?` · ${esc(time)}`:''}</button>`;}
  function bindCalendar(){document.querySelector('[data-cal-prev]').onclick=()=>{calendarView==='week'?calendarCursor.setDate(calendarCursor.getDate()-7):calendarCursor.setMonth(calendarCursor.getMonth()-1);schoolDashboard();};document.querySelector('[data-cal-next]').onclick=()=>{calendarView==='week'?calendarCursor.setDate(calendarCursor.getDate()+7):calendarCursor.setMonth(calendarCursor.getMonth()+1);schoolDashboard();};document.querySelector('[data-cal-view]').onclick=()=>{calendarView=calendarView==='month'?'week':'month';schoolDashboard();};document.querySelectorAll('[data-edit-assignment]').forEach(b=>b.onclick=()=>assignmentForm(schoolData.assignments.find(a=>String(a.id)===b.dataset.editAssignment)));}
  async function classesPage(){await loadSchool(); const terms=schoolData.terms; const active=terms.find(t=>String(t.id)===String(selectedTermId))||activeTerm();const noTerms=!terms.length;setView(`<section class="card"><div class="section-head"><div><h2>Terms</h2><p class="muted">Active term is shown first. Archive terms when they end.</p></div>${button('New term','primary','data-term-new')}</div><div class="term-list">${terms.map(t=>`<button data-term="${esc(t.id)}" class="${active&&String(t.id)===String(active.id)?'active':''}">${esc(t.name)} <small>${esc(t.status)}</small></button>`).join('')||'<span class="muted">No terms yet.</span>'}</div></section><section class="card section"><div class="section-head"><h2>${esc(active?.name||'Classes')}</h2><div class="actions">${active?button('Edit term','ghost','data-term-edit'):''}${button('New class','primary',`data-class-new ${noTerms?'disabled title="Create a term first"':''}`)}</div></div>${noTerms?'<div class="notice">Create a term before adding a class.</div>':schoolData.classes.filter(c=>active&&String(c.termId)===String(active.id)).map(c=>`<div class="work-row"><div><strong>${esc(c.name)}</strong><small>${esc(c.code||'')} · ${esc(c.instructor||'Instructor TBD')}</small></div>${button('Open','ghost',`data-class="${esc(c.id)}"`)}</div>`).join('')||'<div class="empty">No classes in this term.</div>'}</section>`);document.querySelector('[data-term-new]').onclick=()=>termForm();document.querySelector('[data-class-new]')?.addEventListener('click',()=>{if(!noTerms)classForm();});document.querySelector('[data-term-edit]')?.addEventListener('click',()=>termForm(active));document.querySelectorAll('[data-class]').forEach(b=>b.onclick=()=>classDetail(b.dataset.class));document.querySelectorAll('[data-term]').forEach(b=>b.onclick=()=>{selectedTermId=b.dataset.term;classesPage();});}
  function simpleForm(title, body, save){setView(`<section class="card"><div class="section-head"><h2>${esc(title)}</h2>${button('Back','ghost','data-back')}</div><form id="school-form">${body}<div class="actions">${button('Save','primary','type="submit"')}</div></form></section>`);document.querySelector('[data-back]').onclick=()=>navigate('classes');document.querySelector('#school-form').onsubmit=save;}
  function termForm(t={}){simpleForm(t.id?'Edit term':'New term',`<div class="form-grid"><div class="field"><label>Name<input name="name" required value="${esc(t.name)}"></label></div><div class="field"><label>Status<select name="status"><option value="active">active</option><option value="archived" ${t.status==='archived'?'selected':''}>archived</option></select></label></div><div class="field"><label>Start<input name="start" type="date" required value="${esc(t.start||'')}"></label></div><div class="field"><label>End<input name="end" type="date" required value="${esc(t.end||'')}"></label></div></div>${t.id?button('Delete term','danger','type="button" data-delete-term'):''}`,async e=>{e.preventDefault();try{let f=e.currentTarget;await api(t.id?`/api/terms/${t.id}`:'/api/terms',{method:t.id?'PATCH':'POST',body:JSON.stringify(Object.fromEntries(new FormData(f)))});navigate('classes');}catch(x){notify(x.message,true);}});document.querySelector('[data-delete-term]')?.addEventListener('click',async()=>{if(!confirm('Delete this term, its classes, and all of their assignments?'))return;try{await api(`/api/terms/${t.id}`,{method:'DELETE'});navigate('classes');}catch(e){notify(e.message,true);}});}
  function classForm(c={}){if(!c.id&&!schoolData.terms.length){notify('Create a term before adding a class.',true);return;}const termOptions=schoolData.terms.map(t=>`<option value="${esc(t.id)}" ${String(t.id)===String(c.termId||activeTerm()?.id)?'selected':''}>${esc(t.name)}</option>`).join('');const fields=['name','code','instructor','contact','schedule','location','officeHours','links','syllabusNotes','notes'];simpleForm(c.id?'Edit class':'New class',`<div class="form-grid"><div class="field"><label>Term<select name="termId" required>${termOptions}</select></label></div>${fields.map(k=>`<div class="field ${['links','syllabusNotes','notes'].includes(k)?'wide':''}"><label>${esc(k.replace(/([A-Z])/g,' $1'))}${['syllabusNotes','notes'].includes(k)?`<textarea name="${k}">${esc(c[k]||'')}</textarea>`:`<input name="${k}" ${k==='name'?'required':''} value="${esc(c[k]||'')}">`}</label></div>`).join('')}</div>${c.id?button('Delete class','danger','type="button" data-delete-class'):''}`,async e=>{e.preventDefault();try{let f=e.currentTarget, payload=Object.fromEntries(new FormData(f));payload.termId=Number(payload.termId);await api(c.id?`/api/classes/${c.id}`:'/api/classes',{method:c.id?'PATCH':'POST',body:JSON.stringify(payload)});navigate('classes');}catch(x){notify(x.message,true);}});document.querySelector('[data-delete-class]')?.addEventListener('click',async()=>{if(!confirm('Delete this class and its assignments?'))return;try{await api(`/api/classes/${c.id}`,{method:'DELETE'});navigate('classes');}catch(e){notify(e.message,true);}});}
  function safeLink(url){try{const parsed=new URL(url);return /^https?:$/.test(parsed.protocol)?`<a href="${esc(parsed.href)}" target="_blank" rel="noopener noreferrer">${esc(url)}</a>`:esc(url||'None');}catch{return esc(url||'None');}}
  async function classDetail(id){await loadSchool();const c=classFor(id), rows=schoolData.assignments.filter(a=>String(a.classId)===String(id));setView(`<section class="card"><div class="section-head"><div><h2>${esc(c.name)}</h2><p class="muted">${esc(c.code)} · ${esc(c.instructor)}</p></div><div class="actions">${button('Edit class','ghost','data-edit-class')}${button('New assignment','primary','data-new-assignment')}</div></div><div class="detail-grid"><div><b>Location</b><span>${esc(c.location||'Not set')}</span></div><div><b>Schedule</b><span>${esc(c.schedule||'Not set')}</span></div><div><b>Office hours</b><span>${esc(c.officeHours||'Not set')}</span></div><div><b>Contact</b><span>${esc(c.contact||'Not set')}</span></div><div><b>Useful links</b><span>${safeLink(c.links)}</span></div><div><b>Syllabus notes</b><span>${esc(c.syllabusNotes||'No syllabus notes.')}</span></div><div><b>Free notes</b><span>${esc(c.notes||'No free notes.')}</span></div></div><h3>Upcoming assignments</h3>${rows.filter(a=>a.status!=='done'&&a.due).map(a=>assignmentRow(a,false)).join('')||'<p class="muted">No scheduled work.</p>'}<h3>Unscheduled work</h3>${rows.filter(a=>a.status!=='done'&&!a.due).map(a=>assignmentRow(a,false)).join('')||'<p class="muted">None.</p>'}<details><summary>Completed work (${rows.filter(a=>a.status==='done').length})</summary>${rows.filter(a=>a.status==='done').map(a=>assignmentRow(a,false)).join('')}</details></section>`);document.querySelector('[data-edit-class]').onclick=()=>classForm(c);document.querySelector('[data-new-assignment]').onclick=()=>assignmentForm(null,c.id);bindCompletion();}
  function datetimeLocalValue(value){if(!value)return '';const p=tzParts(new Date(value),schoolTimezone),pad=n=>String(n).padStart(2,'0');return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;}
  function wallInputToIso(value){if(!value)return null;const [date,time]=value.split('T'),[year,month,day]=date.split('-').map(Number),[hour,minute]=time.split(':').map(Number);return wallTimeToIso(year,month,day,hour,minute,schoolTimezone);}
  function assignmentForm(a={}, classId){a ||= {};const options=schoolData.classes.map(c=>`<option value="${esc(c.id)}" ${String(c.id)===String(a.classId||classId)?'selected':''}>${esc(c.name)}</option>`).join('');simpleForm(a.id?'Edit assignment':'New assignment',`<div class="form-grid"><div class="field"><label>Class<select name="classId" required>${options}</select></label></div>${['title','type','usefulLink','notes'].map(k=>`<div class="field"><label>${k}<input name="${k}" ${k==='title'?'required':''} value="${esc(a[k]||'')}"></label></div>`).join('')}<div class="field"><label>Due<input name="due" type="datetime-local" value="${a.due?esc(datetimeLocalValue(a.due)):''}"></label></div><div class="field"><label>Warning minutes<input name="warningMinutes" type="number" min="0" value="${esc(a.warningMinutes||'')}"></label></div></div>${a.id?button('Delete assignment','danger','type="button" data-delete-assignment'):''}`,async e=>{e.preventDefault();try{let o=Object.fromEntries(new FormData(e.currentTarget));o.classId=Number(o.classId);o.due=wallInputToIso(o.due);o.warningMinutes=o.warningMinutes?Number(o.warningMinutes):null;await api(a.id?`/api/assignments/${a.id}`:'/api/assignments',{method:a.id?'PATCH':'POST',body:JSON.stringify(o)});navigate('classes');}catch(x){notify(x.message,true);}});document.querySelector('[data-delete-assignment]')?.addEventListener('click',async()=>{if(!confirm('Delete this assignment?'))return;try{await api(`/api/assignments/${a.id}`,{method:'DELETE'});navigate('classes');}catch(e){notify(e.message,true);}});}
  async function calendarReview() { const [pending, history, queue] = await Promise.all([api('/api/candidates?status=pending').catch(()=>[]),api('/api/candidates?status=history').catch(()=>[]),api('/api/queue').catch(()=>({}))]); updatePendingBadge(pending.length); const render=(rows,title)=>`<section class="card"><div class="section-head"><div><h2>${title}</h2><p class="muted">Review email-derived calendar proposals separately from school due dates.</p></div><div class="actions">${button('Scan inbox','primary','data-scan-now')}${queue.paused?button('Resume queue','ghost','data-q="resume"'):button('Pause queue','ghost','data-q="pause"')}${count(queue.failed)?button('Retry failed','ghost','data-retry-school-calendar'):''}</div></div>${candidateList(rows)}</section>`; setView(`${render(pending,'Pending proposals')}<section class="card section"><details><summary>Candidate history (${history.length})</summary>${candidateList(history)}</details><details class="section"><summary>Queue details</summary><p class="muted">${count(queue.queued)} queued · ${count(queue.processing)} processing · ${count(queue.failed)} failed</p></details></section>`);bindCandidateList(pending.concat(history));document.querySelector('[data-scan-now]').onclick=scanNow;document.querySelector('[data-q]').onclick=async e=>{try{await api('/api/queue/'+e.currentTarget.dataset.q,{method:'POST'});calendarReview();}catch(x){notify(x.message,true);}}; document.querySelector('[data-retry-school-calendar]')?.addEventListener('click',async()=>{try{await api('/api/queue/retry-failed',{method:'POST'});notify('Failed messages returned to the queue.');calendarReview();}catch(x){notify(x.message,true);}}); }
  async function documentsPage(){
    const data=await api('/api/documents'), folders=data.folders||[], documents=data.documents||[];
    const rows=folders.map(folder=>`<section class="document-folder"><h3>${esc(folder.path)}</h3>${documents.filter(document=>String(document.folderId)===String(folder.id)).map(document=>`<div class="work-row"><div><strong>${esc(document.name)}</strong><small>${esc(document.mimeType)} · ${document.immutable?'original':'editable'} · ${esc(formatDate(document.updatedAt))}</small></div><span class="tag">${esc(document.sourceKind)}</span></div>`).join('')||'<p class="muted">Empty folder</p>'}</section>`).join('');
    setView(`<section class="card"><div class="section-head"><div><h2>Add to Unsorted</h2><p class="muted">Uploads and pasted text are saved unchanged. Ask the agent to organize them when ready.</p></div></div><form id="document-form"><div class="field"><label>Paste text<textarea name="text" rows="6" placeholder="Paste syllabus, notes, assignments, or other material"></textarea></label></div><div class="field"><label>Files<input name="files" type="file" multiple></label></div>${button('Save to Unsorted','primary','type="submit"')}</form></section><section class="card section"><div class="section-head"><h2>Agent-managed folders</h2>${button('Open agent','ghost','data-open-agent')}</div><div class="document-tree">${rows||'<div class="empty">No documents yet.</div>'}</div></section>`);
    document.querySelector('[data-open-agent]').onclick=()=>navigate('agent');
    document.querySelector('#document-form').onsubmit=async event=>{event.preventDefault();const form=event.currentTarget, body=new FormData();if(form.text.value.trim())body.append('text',form.text.value);Array.from(form.files.files||[]).forEach(file=>body.append('files',file));try{await api('/api/documents',{method:'POST',body});notify('Saved to Unsorted.');documentsPage();}catch(error){notify(error.message,true);}};
  }
  let activeConversationId=null;
  const toolResultMarkup=(label,content,isError=false)=>`<details class="chat-message tool ${isError?'error':''}"><summary>${esc(label)}</summary><div>${esc(content)}</div></details>`;
  async function agentPage(){
    let conversations=await api('/api/agent/conversations');
    if(!conversations.length){const created=await api('/api/agent/conversations',{method:'POST'});conversations=[created];}
    activeConversationId=activeConversationId||Number(conversations[0].id);
    const detail=await api(`/api/agent/conversations/${activeConversationId}`), messages=detail.messages||[], confirmations=(detail.confirmations||[]).filter(item=>item.status==='pending');
    const transcript=messages.map(message=>message.role==='tool'?toolResultMarkup(`tool${message.tool_name?` · ${message.tool_name}`:''}`,message.content,Boolean(message.is_error)):`<article class="chat-message ${esc(message.role)}"><small>${esc(message.role)}</small><div>${message.role==='assistant'?markdown(message.content):esc(message.content)}</div></article>`).join('');
    const pending=confirmations.map(item=>`<div class="notice error"><p>Confirm ${esc(item.action)} ${esc(item.arguments)}</p><div class="actions">${button('Confirm','danger',`data-confirm="${esc(item.id)}"`)}${button('Cancel','ghost',`data-cancel="${esc(item.id)}"`)}</div></div>`).join('');
    setView(`<div class="agent-layout"><aside class="card conversation-list"><div class="section-head"><h2>Conversations</h2>${button('New','ghost','data-new-conversation')}</div>${conversations.map(item=>`<button class="conversation-link ${Number(item.id)===activeConversationId?'active':''}" data-conversation="${esc(item.id)}">${esc(item.title)}</button>`).join('')}</aside><section class="card chat-panel"><div id="chat-log" class="chat-log">${transcript||'<div class="empty">Ask the agent to inspect, organize, or update your school workspace.</div>'}${pending}</div><form id="chat-form" class="chat-form"><label class="visually-hidden" for="chat-input">Message</label><textarea id="chat-input" rows="3" placeholder="Ask a question or request an action" required></textarea>${button('Send','primary','type="submit"')}</form></section></div>`);
    document.querySelectorAll('[data-conversation]').forEach(buttonEl=>buttonEl.onclick=()=>{activeConversationId=Number(buttonEl.dataset.conversation);agentPage();});
    document.querySelector('[data-new-conversation]').onclick=async()=>{const created=await api('/api/agent/conversations',{method:'POST'});activeConversationId=Number(created.id);agentPage();};
    document.querySelectorAll('[data-confirm],[data-cancel]').forEach(buttonEl=>buttonEl.onclick=async()=>{try{const response=await fetch(`/api/agent/confirmations/${buttonEl.dataset.confirm||buttonEl.dataset.cancel}`,{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify({confirm:Boolean(buttonEl.dataset.confirm)})});if(!response.ok)throw new Error(`Request failed (${response.status})`);buttonEl.closest('.notice').remove();await streamAgentResponse(response,document.querySelector('#chat-log'));await agentPage();}catch(error){notify(error.message,true);}});
    document.querySelector('#chat-form').onsubmit=sendAgentMessage;
    const log=document.querySelector('#chat-log');
    requestAnimationFrame(()=>{log.scrollTop=log.scrollHeight;});
  }
  async function streamAgentResponse(response,log){const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';while(true){const {done,value}=await reader.read();buffer+=decoder.decode(value||new Uint8Array(),{stream:!done});const lines=buffer.split('\n');buffer=lines.pop()||'';for(const line of lines){if(!line)continue;const item=JSON.parse(line);if(item.type==='tool')log.insertAdjacentHTML('beforeend',toolResultMarkup(`tool · ${item.action||'action'}`,item.result||'',Boolean(item.isError)));else log.insertAdjacentHTML('beforeend',`<article class="chat-message assistant ${item.type==='error'?'error':''}"><small>${esc(item.type)}</small><div>${markdown(item.text||item.result||'')}</div></article>`);log.scrollTop=log.scrollHeight;}if(done)break;}}
  async function sendAgentMessage(event){
    event.preventDefault();const input=document.querySelector('#chat-input'), send=event.currentTarget.querySelector('[type="submit"]'), log=document.querySelector('#chat-log'), text=input.value;input.value='';send.disabled=true;input.disabled=true;log.insertAdjacentHTML('beforeend',`<article class="chat-message user"><small>user</small><div>${esc(text)}</div></article>`);log.scrollTop=log.scrollHeight;
    try{const response=await fetch(`/api/agent/conversations/${activeConversationId}/messages`,{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify({text})});if(!response.ok)throw new Error(`Request failed (${response.status})`);await streamAgentResponse(response,log);await agentPage();}catch(error){notify(error.message,true);send.disabled=false;input.disabled=false;}
  }
  async function openWorkspace() {
    try {
      const status = await api('/api/dashboard');
      if (!status.setupComplete) await wizardForStatus(status);
      else navigate('dashboard');
    } catch (error) { notify(error.message, true); }
  }

  (async () => {
    try {
      boot = await api('/api/bootstrap');
      csrf = boot.csrfToken || '';
      if (!boot.configured) auth(true);
      else if (boot.authenticated) openWorkspace();
      else auth(false);
    } catch {
      auth(false);
      notify('Unable to reach the service. You can try signing in again.', true);
    }
  })();
})();
