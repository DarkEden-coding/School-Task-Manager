(() => {
  'use strict';

  const app = document.querySelector('#app');
  const toast = document.querySelector('#toast');
  let csrf = '';
  let boot = {};
  let current = 'dashboard';
  let poller;
  let loginPoller;
  let scanRunId = null;
  let scanBaseline = 0;

  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const button = (text, kind = '', attributes = '') => `<button class="button ${kind}" ${attributes}>${text}</button>`;
  const count = (value) => Number(value) || 0;
  const formatDate = (value) => {
    if (!value) return 'Not available';
    const date = new Date(value);
    return Number.isNaN(date.valueOf()) ? String(value) : date.toLocaleString();
  };
  const notify = (text, isError = false) => {
    toast.textContent = text;
    toast.style.borderColor = isError ? '#e35d75' : '';
    toast.classList.add('show');
    clearTimeout(notify.timer);
    notify.timer = setTimeout(() => toast.classList.remove('show'), 4500);
  };

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
    return `<div class="shell"><aside class="sidebar"><div class="brand"><i>✦</i> Signal Mail</div><nav>${nav.map(([id, icon, label]) => `<button class="${view === id ? 'active' : ''}" data-view="${id}"><span class="ico">${icon}</span>${label}</button>`).join('')}</nav><div class="side-foot">${button('Sign out', 'ghost', 'data-action="logout"')}</div></aside><section class="content"><header class="topbar"><div><div class="eyebrow">Email → Calendar</div><h1>${titles[view]}</h1></div></header><div id="view"><div class="loading"><span class="spinner"></span></div></div></section><nav class="mobile-nav">${nav.map(([id, , label]) => `<button class="${view === id ? 'active' : ''}" data-view="${id}">${label}</button>`).join('')}</nav></div>`;
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
    const [status, queue, pending] = await Promise.all([
      api('/api/dashboard'),
      api('/api/queue'),
      api('/api/candidates?status=pending').catch(() => []),
    ]);
    renderDashboard(status, queue, Array.isArray(pending) ? pending : []);
    poller = setInterval(async () => {
      if (current !== 'dashboard') return;
      try {
        const [latestStatus, latestQueue, latestPending] = await Promise.all([api('/api/dashboard'), api('/api/queue'), api('/api/candidates?status=pending').catch(() => [])]);
        renderDashboard(latestStatus, latestQueue, Array.isArray(latestPending) ? latestPending : []);
      } catch { /* Leave the last useful status visible. */ }
    }, 30000);
  }

  function renderDashboard(status, queue, pending) {
    const queueTotal = count(queue.queued) + count(queue.processing) + count(queue.processed) + count(queue.failed);
    const progress = queueTotal ? Math.round((count(queue.processed) / queueTotal) * 100) : 0;
    setView(`<div class="grid stats"><div class="card stat"><div class="label">Awaiting review</div><div class="num blue">${count(status.pendingCount)}</div></div><div class="card stat"><div class="label">Queued messages</div><div class="num yellow">${count(status.queuedCount)}</div></div><div class="card stat"><div class="label">Processing now</div><div class="num green">${count(queue.processing)}</div></div><div class="card stat"><div class="label">Failed messages</div><div class="num">${count(status.failedCount)}</div></div></div><div class="grid split section"><section class="card"><div class="section-head"><div><h2>Needs your attention</h2><p class="muted">${status.setupComplete ? 'Review proposed calendar changes before they are applied.' : 'Finish setup to begin reviewing meeting suggestions.'}</p></div>${button(status.setupComplete ? 'Open queue' : 'Finish setup', 'primary', 'data-go="candidates"')}</div>${candidateList(pending, true)}</section><section class="card"><div class="section-head"><h2>Queue control</h2><div class="queuebar"><span class="dot ${queue.paused ? 'paused' : ''}"></span>${queue.paused ? 'Paused' : status.scanRunning ? 'Scanning' : 'Running'}</div></div><p class="muted">${count(queue.queued)} queued · ${count(queue.processing)} processing · ${count(queue.processed)} processed · ${count(queue.failed)} failed</p><div class="progress"><span style="width:${progress}%"></span></div><small class="muted">Last successful scan: ${esc(formatDate(status.lastSuccessfulScan))}<br>Next scan: ${esc(status.nextScan || 'Not scheduled')}</small><div class="actions section">${queue.paused ? button('Resume queue', 'good', 'data-queue="resume"') : button('Pause queue', 'ghost', 'data-queue="pause"')}${button('Scan now', 'primary', 'data-scan-now')}</div>${status.lastError ? `<div class="notice error">${esc(status.lastError)}</div>` : ''}</section></div><section class="card section connection-card"><h2>Connections</h2><p class="muted">Google: ${status.googleConnected ? 'Connected' : 'Not connected'} · OpenAI: ${status.openaiConnected ? 'Connected' : 'Not connected'}</p></section>`);
    document.querySelector('[data-go]')?.addEventListener('click', () => status.setupComplete ? navigate('candidates') : wizardForStatus(status));
    document.querySelector('[data-queue]')?.addEventListener('click', queueAction);
    document.querySelector('[data-scan-now]')?.addEventListener('click', scanNow);
  }

  function candidateList(rows, compact = false) {
    if (!rows.length) return '<div class="empty">Nothing needs review right now.</div>';
    return rows.slice(0, compact ? 4 : 100).map((candidate) => `<article class="item ${compact ? '' : 'candidate'}"><span class="tag ${esc(candidate.changeKind)}">${esc(candidate.changeKind || 'create')}</span><div class="item-body"><div class="item-title">${esc(candidate.title || 'Untitled event')}</div><p>${esc(candidate.start ? `${formatDate(candidate.start)}${candidate.timezone ? ` · ${candidate.timezone}` : ''}` : 'Time to be confirmed')}</p></div>${compact ? '' : `<div class="actions">${button('Review', 'ghost', `data-review="${Number(candidate.id)}"`)}</div>`}</article>`).join('');
  }

  async function candidates(status) {
    const data = await api(`/api/candidates?status=${status}`);
    const rows = Array.isArray(data) ? data : [];
    setView(`<section class="card"><div class="section-head"><div><h2>${status === 'pending' ? 'Proposed calendar changes' : 'Decision history'}</h2><p class="muted">${status === 'pending' ? 'Create, update, and cancellation requests are clearly labelled for review.' : 'Approved, denied, and superseded proposals.'}</p></div>${status === 'pending' ? button('Scan inbox', 'primary', 'data-scan-now') : ''}</div>${candidateList(rows)}</section>`);
    document.querySelectorAll('[data-review]').forEach((element) => { element.onclick = () => review(rows.find((item) => Number(item.id) === Number(element.dataset.review))); });
    document.querySelector('[data-scan-now]')?.addEventListener('click', scanNow);
  }

  async function review(candidate) {
    if (!candidate) return;
    const kind = candidate.changeKind || 'create';
    const explanation = kind === 'cancel' ? 'Cancel removes the related calendar event after approval.' : kind === 'update' ? 'Update changes the related calendar event after approval.' : 'Create adds a new calendar event after approval.';
    setView(`<section class="card"><div class="section-head"><div><span class="tag ${esc(kind)}">${esc(kind)}</span><h2 style="margin-top:10px">${esc(candidate.title)}</h2><p class="muted">${esc(explanation)}</p></div>${button('Back', 'ghost', 'data-back')}</div><div class="notice">Check every proposed detail before approving this ${esc(kind)} request.</div><div class="form-grid"><div class="field"><label for="ctitle">Title</label><input id="ctitle" value="${esc(candidate.title)}"></div><div class="field"><label for="ccalendar">Destination calendar</label><select id="ccalendar"><option value="${esc(candidate.calendarId)}">${esc(candidate.calendarId || 'Choose a calendar')}</option></select></div><div class="field"><label for="cstart">Start</label><input id="cstart" value="${esc(candidate.start || '')}" placeholder="ISO date/time or blank"></div><div class="field"><label for="cend">End</label><input id="cend" value="${esc(candidate.end || '')}" placeholder="ISO date/time or blank"></div><div class="field"><label for="ctimezone">Timezone</label><input id="ctimezone" value="${esc(candidate.timezone)}"></div><div class="field"><label for="clocation">Location</label><input id="clocation" value="${esc(candidate.location)}"></div><div class="field"><label for="corganizer">Organizer</label><input id="corganizer" value="${esc(candidate.organizer)}"></div><div class="field"><label for="curl">Registration URL</label><input id="curl" type="url" value="${esc(candidate.registrationUrl)}"></div><div class="field wide"><label for="cdescription">Description</label><textarea id="cdescription" rows="5">${esc(candidate.description)}</textarea></div></div><div class="detail-grid"><div><b>Confidence</b><span>${esc(`${Math.round((Number(candidate.confidence) || 0) * 100)}%`)}</span></div><div><b>Uncertainty</b><span>${esc((candidate.uncertaintyNotes || []).join(' · ') || 'None noted')}</span></div><div><b>Sources</b><span>${esc((candidate.sourceMessageIds || []).join(', ') || 'No message IDs recorded')}</span></div><div><b>Source excerpt</b><span>${esc(candidate.sourceExcerpt || 'Not available')}</span></div></div><div class="actions section">${button(kind === 'cancel' ? 'Approve cancellation' : kind === 'update' ? 'Approve update' : 'Approve & create', 'good', 'data-approve')}${button('Deny proposal', 'danger', 'data-deny')}</div></section>`);
    document.querySelector('[data-back]').onclick = () => navigate('candidates');
    document.querySelector('[data-approve]').onclick = () => decision(candidate.id, 'approve');
    document.querySelector('[data-deny]').onclick = () => decision(candidate.id, 'deny');
    api('/api/google/calendars').then((calendars) => fillSelect('ccalendar', calendars, candidate.calendarId)).catch(() => {});
  }

  async function decision(id, action) {
    try {
      if (action === 'approve') {
        const value = (id) => document.querySelector(`#${id}`).value;
        await api(`/api/candidates/${id}`, { method: 'PATCH', body: JSON.stringify({
          title: value('ctitle'), calendarId: value('ccalendar'), start: value('cstart') || null, end: value('cend') || null,
          timezone: value('ctimezone'), location: value('clocation'), organizer: value('corganizer'), registrationUrl: value('curl'), description: value('cdescription'),
        }) });
      }
      await api(`/api/candidates/${id}/${action}`, { method: 'POST' });
      notify(action === 'approve' ? 'Calendar change approved.' : 'Proposal denied.');
      navigate('candidates');
    } catch (error) { notify(error.message, true); }
  }

  async function queueAction(event) {
    try { await api(`/api/queue/${event.currentTarget.dataset.queue}`, { method: 'POST' }); await dashboard(); } catch (error) { notify(error.message, true); }
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

  async function settings() {
    const [saved, status] = await Promise.all([api('/api/settings'), api('/api/dashboard')]);
    const [labels, calendars, models] = await Promise.all([
      status.googleConnected ? api('/api/google/labels').catch(() => []) : Promise.resolve([]),
      status.googleConnected ? api('/api/google/calendars').catch(() => []) : Promise.resolve([]),
      status.openaiConnected ? api('/api/openai/models').catch(() => []) : Promise.resolve([]),
    ]);
    setView(`<section class="card"><div class="section-head"><div><h2>Workspace settings</h2><p class="muted">Choose sources, scheduling, and the model used to prepare proposals.</p></div></div><form id="settings-form"><div class="form-grid"><div class="field"><label for="scanTime">Daily scan time</label><input id="scanTime" name="scanTime" type="time" value="${esc(saved.scanTime)}"></div><div class="field"><label for="timezone">Timezone</label><input id="timezone" name="timezone" value="${esc(saved.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone)}"></div><div class="field"><label for="gmailLabelIds">Gmail labels</label><select id="gmailLabelIds" name="gmailLabelIds" multiple ${status.googleConnected ? '' : 'disabled'}>${optionMarkup(labels, saved.gmailLabelIds, status.googleConnected ? 'No label selected' : 'Connect Google first')}</select><small class="muted">Use Ctrl/Cmd to select multiple labels.</small></div><div class="field"><label for="calendarId">Destination calendar</label><select id="calendarId" name="calendarId" ${status.googleConnected ? '' : 'disabled'}>${optionMarkup(calendars, saved.calendarId, status.googleConnected ? 'Choose a calendar' : 'Connect Google first')}</select></div><div class="field"><label for="modelId">OpenAI model</label><select id="modelId" name="modelId" ${status.openaiConnected ? '' : 'disabled'}>${optionMarkup(models, saved.modelId, status.openaiConnected ? 'Choose a model' : 'Connect OpenAI first')}</select></div><div class="field"><label for="reasoningLevel">Reasoning level</label><select id="reasoningLevel" name="reasoningLevel"></select></div><div class="field wide"><label for="interests">Interests & context</label><textarea id="interests" name="interests" rows="4">${esc(saved.interests)}</textarea></div><div class="field wide"><label for="filterRules">Filter rules</label><textarea id="filterRules" name="filterRules" rows="4" placeholder="Describe emails or events to ignore.">${esc(saved.filterRules)}</textarea></div><div class="field"><label><input id="scanPaused" name="scanPaused" type="checkbox" ${saved.scanPaused ? 'checked' : ''}> Pause queue processing</label></div></div>${button('Save settings', 'primary', 'type="submit"')}</form></section>`);
    const updateReasoning = () => {
      const model = models.find((item) => item.id === document.querySelector('#modelId').value);
      const levels = model?.reasoningLevels?.length ? model.reasoningLevels : ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
      fillSelect('reasoningLevel', levels.map((level) => ({ id: level, name: level })), saved.reasoningLevel, 'Choose a level');
    };
    updateReasoning();
    document.querySelector('#modelId')?.addEventListener('change', updateReasoning);
    document.querySelector('#settings-form').onsubmit = async (event) => {
      event.preventDefault();
      try {
        const form = event.currentTarget;
        const payload = {
          scanTime: form.scanTime.value, timezone: form.timezone.value,
          gmailLabelIds: Array.from(form.gmailLabelIds.selectedOptions).map((option) => option.value).filter(Boolean),
          calendarId: form.calendarId.value, modelId: form.modelId.value, reasoningLevel: form.reasoningLevel.value,
          interests: form.interests.value, filterRules: form.filterRules.value, scanPaused: form.scanPaused.checked,
        };
        await api('/api/settings', { method: 'PATCH', body: JSON.stringify(payload) });
        notify('Settings saved.');
      } catch (error) { notify(error.message, true); }
    };
  }

  function auth(setup) {
    app.innerHTML = `<div class="auth card"><div class="brand"><i>✦</i> Signal Mail</div><h1>${setup ? 'Create your secure workspace' : 'Welcome back'}</h1><p class="sub">${setup ? 'Create a password to protect your connected accounts.' : 'Sign in to review your meeting intelligence.'}</p><form id="authform"><div class="field"><label for="password">Password</label><input id="password" type="password" minlength="12" required autocomplete="${setup ? 'new-password' : 'current-password'}" placeholder="At least 12 characters"></div>${button(setup ? 'Continue setup' : 'Sign in', 'primary', 'type="submit"')}</form></div>`;
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
    if (!status.openaiConnected) return wizard(2);
    return wizard(4);
  }

  async function wizard(step) {
    clearInterval(loginPoller);
    scanRunId = null;
    let saved = {};
    try { saved = await api('/api/settings'); } catch { /* Wizard can still show its connection step. */ }
    const googleCallbackUrl = boot.googleCallbackUrl || `${location.origin}/api/google/callback`;
    const pages = {
      1: `<h1>Connect Google</h1><p class="sub">Upload your OAuth client credentials, then authorize Gmail and Calendar access.</p><p class="setup-help"><a href="https://console.cloud.google.com/apis/credentials/oauthclient" target="_blank" rel="noopener noreferrer">Create a Google OAuth client ↗</a></p><div class="oauth-guide"><div><span>Application type</span><strong>Web application</strong></div><div><span>Name</span><strong>Signal Mail</strong></div><div><span>Authorized JavaScript origins</span><strong>Leave empty</strong></div><div class="wide"><span>Authorized redirect URI</span><code>${esc(googleCallbackUrl)}</code></div></div><p class="setup-note">If Google asks for a consent screen, choose <strong>External</strong>, keep it in testing, and add your Google account as a test user.</p><div class="file"><div class="file-copy"><span class="file-title">Google OAuth client JSON</span><span id="client-name" class="file-name">No file selected</span></div><label class="button ghost file-picker" for="client">Choose file</label><input id="client" class="visually-hidden" type="file" accept="application/json,.json"></div><div class="actions section">${button('Upload credentials', 'ghost', 'data-upload')}${button('Connect Google', 'primary', 'data-connect')}</div>`,
      2: `<h1>Choose sources</h1><p class="sub">Select one or more Gmail labels and the calendar where approved events belong.</p><div class="form-grid source-grid"><div class="field"><span class="field-label">Gmail labels</span><div id="label" class="choice-list" role="group" aria-label="Gmail labels"></div></div><div class="field"><label for="calendar-trigger">Destination calendar</label><div id="calendar-select" class="custom-select"><button id="calendar-trigger" class="custom-select-trigger" type="button" aria-haspopup="listbox" aria-expanded="false"><span>Choose a calendar</span><b aria-hidden="true">⌄</b></button><div class="custom-select-menu" role="listbox" hidden></div><input id="calendar" type="hidden"></div></div></div>`,
      3: `<h1>Connect OpenAI</h1><p class="sub">Use your OpenAI subscription to understand email context and suggest calendar changes.</p><div class="actions">${button('Sign in in browser', 'primary', 'data-oai="browser"')}${button('Use device code', 'ghost', 'data-oai="device_code"')}</div><div id="oauth-note" class="section" aria-live="polite"></div><div class="form-grid section"><div class="field"><label for="model">Model</label><select id="model"><option value="">Connect OpenAI to load models</option></select></div><div class="field"><label for="reasoning">Reasoning level</label><select id="reasoning"></select></div></div>`,
      4: `<h1>Tailor your assistant</h1><p class="sub">Set a daily scan time and context so suggestions match your working style.</p><div class="form-grid"><div class="field"><label for="scanTime">Daily scan time</label><input id="scanTime" type="time" value="${esc(saved.scanTime || '09:00')}"></div><div class="field"><label for="timezone">Timezone</label><input id="timezone" value="${esc(saved.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone)}"></div><div class="field wide"><label for="interests">Interests & context</label><textarea id="interests" rows="4">${esc(saved.interests || '')}</textarea></div><div class="field wide"><label for="filterRules">Filter rules</label><textarea id="filterRules" rows="4">${esc(saved.filterRules || '')}</textarea></div></div>`,
      5: `<h1>Initial inbox scan</h1><p class="sub">We’ll count messages in your chosen labels before any processing begins.</p><div id="count" class="notice">Counting eligible messages…</div><div id="initial-progress" class="scan-progress" hidden><div class="progress-label"><strong>Processing email</strong><span id="initial-progress-count">0 of 0</span></div><div class="progress" role="progressbar" aria-label="Initial scan progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span style="width:0%"></span></div><p id="initial-progress-detail" class="muted">Starting three parallel workers…</p></div>`,
    };
    app.innerHTML = `<div class="wizard card"><div class="brand"><i>✦</i> Signal Mail</div><div class="steps">${['Google', 'Sources', 'OpenAI', 'Preferences', 'Scan'].map((label, index) => `<div class="step ${index + 1 === step ? 'active' : index + 1 < step ? 'done' : ''}"><b>${index + 1}</b>${label}</div>`).join('')}</div><div class="wizard-page active">${pages[step]}</div><div class="wizard-footer">${step > 1 ? button('Back', 'ghost', 'data-prev') : ''}<span></span>${step < 5 ? button('Continue', 'primary', 'data-next') : button('Confirm & start scan', 'primary', 'data-finish')}</div></div>`;
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
          const modelId = document.querySelector('#model').value;
          const reasoningLevel = document.querySelector('#reasoning').value;
          if (!modelId) throw new Error('Wait for OpenAI to connect, then choose a model.');
          await api('/api/settings', { method: 'PATCH', body: JSON.stringify({ modelId, reasoningLevel }) });
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
    if (step === 3) setupOpenAiStep(saved);
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
        const queueLine = queue.paused
          ? `Paused · ${count(queue.queued)} queued · ${count(queue.processing)} processing`
          : count(queue.processing) === 0 && count(queue.queued) > 0 && completed === 0
            ? `Collecting message IDs from Gmail… ${count(queue.queued)} queued`
            : `${count(queue.processing)} processing · ${count(queue.queued)} queued${count(queue.failed) ? ` · ${count(queue.failed)} failed` : ''}`;
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

  async function setupOpenAiStep(saved) {
    const note = document.querySelector('#oauth-note');
    const populateModels = async () => {
      const models = await api('/api/openai/models');
      fillSelect('model', models, saved.modelId, 'Choose a model');
      const updateReasoning = () => {
        const selected = models.find((model) => model.id === document.querySelector('#model').value);
        const levels = selected?.reasoningLevels?.length ? selected.reasoningLevels : ['off'];
        fillSelect('reasoning', levels.map((level) => ({ id: level, name: level })), saved.reasoningLevel, 'Choose a level');
      };
      updateReasoning();
      document.querySelector('#model').onchange = updateReasoning;
    };
    const inspect = async () => {
      const status = await api('/api/openai/login');
      note.innerHTML = authEvents(status.events, status.state, status.error);
      if (status.state === 'connected') { clearInterval(loginPoller); await populateModels(); }
      if (status.state === 'failed') clearInterval(loginPoller);
    };
    try {
      await inspect();
      const dashboardStatus = await api('/api/dashboard');
      if (dashboardStatus.openaiConnected && !document.querySelector('#model').options.length) await populateModels();
      if (dashboardStatus.openaiConnected && document.querySelector('#model').options.length === 1 && !document.querySelector('#model').value) await populateModels();
    } catch { /* Login is optional until the user starts it. */ }
    document.querySelectorAll('[data-oai]').forEach((element) => {
      element.onclick = async () => {
        try {
          const status = await api('/api/openai/login', { method: 'POST', body: JSON.stringify({ method: element.dataset.oai }) });
          note.innerHTML = authEvents(status.events, status.state, status.error);
          clearInterval(loginPoller);
          if (status.state === 'connected') await populateModels();
          else loginPoller = setInterval(() => inspect().catch((error) => { note.innerHTML = authEvents([], 'failed', error.message); clearInterval(loginPoller); }), 2000);
        } catch (error) { notify(error.message, true); }
      };
    });
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
