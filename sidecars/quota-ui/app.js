'use strict';

/* ── Constants ────────────────────────────────────────────────────────── */
const POLL_MS = 15_000;
const TICK_MS = 1_000;
const API     = '/api/quota';

/* ── Model Groups Definition ─────────────────────────────────────────── */
const MODEL_GROUPS = [
  {
    id: 'gemini',
    title: 'Gemini',
    has5h: true,
    get5h: (acc) => acc.pools?.gemini_5h || acc.pools?.gemini_flash,
    getWk: (acc) => acc.pools?.gemini_weekly || acc.pools?.gemini_pro,
  },
  {
    id: 'argon',
    title: 'Argon',
    has5h: false,
    get5h: () => null,
    getWk: (acc) => acc.pools?.argon_weekly,
  },
  {
    id: 'claude',
    title: 'Claude',
    has5h: true,
    get5h: (acc) => acc.pools?.claude_5h || acc.pools?.claude_gpt,
    getWk: (acc) => acc.pools?.claude_weekly,
  },
];

/* ── State ────────────────────────────────────────────────────────────── */
let lastData        = null;
let filterText      = '';
let selectedModels  = new Set(['gemini', 'argon']);
let countdowns      = {};
let drawerAccount   = null;
let drawerTrigger   = null;
let pollingTimer    = null;

/* ── DOM Utilities & Sanitization ─────────────────────────────────────── */
function el(id)         { return document.getElementById(id); }
function setText(id, v) { const node = el(id); if (node) node.textContent = v; }

function esc(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* ── Date / Time Formatting (Standard 24h ISO-like, no locale jitter) ── */
function formatTime(isoOrDate) {
  if (!isoOrDate) return '—';
  const d = new Date(isoOrDate);
  if (isNaN(d.getTime())) return '—';
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatDateTime(isoOrDate) {
  if (!isoOrDate) return '—';
  const d = new Date(isoOrDate);
  if (isNaN(d.getTime())) return '—';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/* ── Status Classification (Zen Minimalism: restrained color) ────────── */
function poolClass(pct) {
  if (pct <= 15) return 'crit';
  if (pct <= 40) return 'warn';
  return 'ok';
}

/* ── Countdown Utilities ──────────────────────────────────────────────── */
function formatDiff(ms) {
  if (!ms || isNaN(ms) || ms <= 0) return '✓ Ready';
  const totalMin = Math.floor(ms / 60_000);
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  const s = Math.floor((ms % 60_000) / 1_000);

  if (d > 0) return `${d}d ${h}h ${String(m).padStart(2, '0')}m`;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`;
}

function tickCountdowns() {
  const now = Date.now();
  for (const [key, info] of Object.entries(countdowns)) {
    if (!info.el || !document.contains(info.el)) {
      delete countdowns[key];
      continue;
    }
    const diff = info.endsAt - now;
    const formatted = formatDiff(diff);
    info.el.textContent = formatted;
    if (diff > 0) {
      info.el.className = info.isDrawer ? 'dr-pool-cd cd-active' : 'pool-cd cd-active';
    } else {
      info.el.className = info.isDrawer ? 'dr-pool-cd cd-ready' : 'pool-cd cd-ready';
    }
  }
}

/* ── Health & Status Summary ─────────────────────────────────────────── */
function renderHealthPills(data) {
  const accounts  = data.accounts || [];
  const byStatus  = (s) => accounts.filter(a => a && a.status === s).length;
  const active    = byStatus('active');
  const ready     = byStatus('ready');
  const low       = byStatus('low');
  const exhausted = byStatus('exhausted');

  const parts = [];
  if (active > 0)    parts.push(`<span class="hs-item hs-active">${active}<span class="hs-label"> Active</span></span>`);
  if (ready > 0)     parts.push(`<span class="hs-item hs-ready">${ready}<span class="hs-label"> Ready</span></span>`);
  if (low > 0)       parts.push(`<span class="hs-item hs-low">${low}<span class="hs-label"> Low</span></span>`);
  if (exhausted > 0) parts.push(`<span class="hs-item hs-crit">${exhausted}<span class="hs-label"> Depleted</span></span>`);

  const pillsEl = el('health-pills');
  if (pillsEl) pillsEl.innerHTML = parts.join('<span class="hs-sep">·</span>');

  const rpcEl = el('rpc-warn');
  if (rpcEl) rpcEl.style.display = data.rpc_ok === false ? 'inline-block' : 'none';
}

/* ── Pool Cell Rendering ─────────────────────────────────────────────── */
function renderPoolCell(pool, cdId, isNA = false) {
  if (isNA || !pool) {
    return `<td>
      <div class="pool-wrap">
        <span class="pool-pct pct-na" aria-label="Not available">—</span>
        <div class="bar-track"><div class="bar-fill bar-na" style="width:0%"></div></div>
        <span class="pool-cd">${isNA ? 'N/A' : '—'}</span>
      </div>
    </td>`;
  }

  const pct    = pool.pct ?? 0;
  const cls    = poolClass(pct);
  const cdText = (pct >= 100) ? '' : (pool.countdown || '');
  const hasCd  = Boolean(cdText && pct < 100 && cdText !== '✓ Ready');
  const cdCls  = hasCd ? 'pool-cd cd-active' : (cdText === '✓ Ready' ? 'pool-cd cd-ready' : 'pool-cd');
  const semCls = cls === 'crit' ? 'critical' : cls === 'warn' ? 'warning' : 'healthy';

  return `<td>
    <div class="pool-wrap">
      <span class="pool-pct pct-${cls}" aria-label="${pct}% remaining (${semCls})">${pct}%</span>
      <div class="bar-track"><div class="bar-fill bar-${cls}" style="width:${pct}%"></div></div>
      <span class="${cdCls}" id="${esc(cdId)}">${esc(cdText)}</span>
    </div>
  </td>`;
}

/* ── Group & Row Rendering (Minimalist Layout) ───────────────────────── */
function renderGroup(grp, accounts) {
  const isRecommended = (email) => (lastData?.switch_recommendations || []).includes(email);

  // Hide accounts without Argon from the Argon model section
  const groupAccounts = grp.id === 'argon'
    ? accounts.filter(acc => Boolean(grp.getWk(acc)))
    : accounts;

  const colCount = grp.has5h ? 3 : 2;
  const th5h     = grp.has5h ? `<th class="th-pool" scope="col">5-Hour</th>` : '';

  const colsIndicator = grp.has5h
    ? `<div class="section-cols cols-3"><span>5-Hour</span><span>Weekly</span></div>`
    : `<div class="section-cols cols-2"><span>Weekly</span></div>`;

  const headerHtml = `
    <div class="section-head">
      <span class="section-title">${esc(grp.title)}</span>
      ${colsIndicator}
    </div>`;
  const theadClass = 'class="sr-only"';

  if (!groupAccounts.length) {
    return `
      <section class="model-section" id="grp-${esc(grp.id)}">
        ${headerHtml}
        <div class="empty-msg">No accounts with ${esc(grp.title)} access.</div>
      </section>
    `;
  }

  const rows = groupAccounts.map(acc => {
    const rawEmail = acc.email || 'unknown';
    const emailKey = rawEmail.replace(/[^a-zA-Z0-9_-]/g, '_');
    const p5h      = grp.get5h(acc);
    const pwk      = grp.getWk(acc);
    const cd5h     = `cd-${grp.id}-${emailKey}-5h`;
    const cdwk     = `cd-${grp.id}-${emailKey}-wk`;

    const td5h = grp.has5h ? renderPoolCell(p5h, cd5h) : '';
    const tdwk = renderPoolCell(pwk, cdwk);

    let badge = '';
    if (acc.is_active) {
      badge = `<span class="acct-badge badge-active">Active</span>`;
    } else if (isRecommended(rawEmail)) {
      badge = `<span class="acct-badge badge-ready">Ready</span>`;
    }

    return `<tr
      class="${acc.is_active ? 'row-active' : ''}"
      data-email="${esc(rawEmail)}"
      tabindex="0"
      aria-label="Account ${esc(rawEmail)} detail"
    >
      <td class="td-acct">
        <div class="acct-wrap">
          <div class="acct-email-row">
            ${acc.is_active ? '<span class="acct-active-pip" title="Active session"></span>' : ''}
            <span class="acct-email" title="${esc(rawEmail)}">${esc(rawEmail)}</span>
          </div>
          <div class="acct-meta">
            <span>${esc(acc.plan || 'Pro')}</span>
            ${badge}
          </div>
        </div>
      </td>
      ${td5h}
      ${tdwk}
    </tr>`;
  }).join('');

  return `
    <section class="model-section" id="grp-${esc(grp.id)}">
      ${headerHtml}
      <table class="quota-table ${grp.has5h ? 'cols-3' : 'cols-2'}">
        <thead ${theadClass}>
          <tr>
            <th class="th-acct" scope="col">Account</th>
            ${th5h}
            <th class="th-pool" scope="col">Weekly</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
    </section>
  `;
}

/* ── Skeleton Placeholder (First Paint) ──────────────────────────────── */
function renderSkeleton() {
  const skelRow = (cols) => {
    const poolCols = Array(cols).fill(`
      <td><div class="pool-wrap">
        <div class="skel skel-pct"></div>
        <div class="skel skel-bar"></div>
        <div class="skel skel-cd"></div>
      </div></td>`).join('');

    return `<tr>
      <td class="td-acct">
        <div class="skel skel-email"></div>
        <div class="skel skel-sub"></div>
      </td>
      ${poolCols}
    </tr>`;
  };

  const visibleGroups = MODEL_GROUPS.filter(g => selectedModels.has(g.id));
  if (!visibleGroups.length) {
    return `<div class="empty-msg">No models selected.<br>Select Gemini, Argon, or Claude above to view quotas.</div>`;
  }

  return visibleGroups.map(grp => {
    const cols = grp.has5h ? 2 : 1;
    const th5h = grp.has5h ? '<th class="th-pool" scope="col">5-Hour</th>' : '';
    const theadClass = 'class="sr-only"';
    const colsIndicator = grp.has5h
      ? `<div class="section-cols cols-3"><span>5-Hour</span><span>Weekly</span></div>`
      : `<div class="section-cols cols-2"><span>Weekly</span></div>`;

    return `
      <section class="model-section">
        <div class="section-head"><span class="section-title">${esc(grp.title)}</span>${colsIndicator}</div>
        <table class="quota-table ${grp.has5h ? 'cols-3' : 'cols-2'}">
          <thead ${theadClass}><tr><th class="th-acct" scope="col">Account</th>${th5h}<th class="th-pool" scope="col">Weekly</th></tr></thead>
          <tbody>${skelRow(cols)}${skelRow(cols)}</tbody>
        </table>
      </section>`;
  }).join('');
}

/* ── Countdown Registration ─────────────────────────────────────────── */
function registerCountdowns(accounts) {
  countdowns = {};
  const visibleGroups = MODEL_GROUPS.filter(g => selectedModels.has(g.id));

  for (const grp of visibleGroups) {
    const groupAccounts = grp.id === 'argon'
      ? accounts.filter(acc => Boolean(grp.getWk(acc)))
      : accounts;

    for (const acc of groupAccounts) {
      if (!acc || !acc.email) continue;
      const rawEmail = acc.email;
      const emailKey = rawEmail.replace(/[^a-zA-Z0-9_-]/g, '_');
      const pairs = [
        { pool: grp.get5h(acc), key: '5h' },
        { pool: grp.getWk(acc), key: 'wk' },
      ];
      for (const { pool, key } of pairs) {
        if (!pool || pool.pct >= 100 || !pool.reset_time) continue;
        const cdId   = `cd-${grp.id}-${emailKey}-${key}`;
        const cdEl   = document.getElementById(cdId);
        if (!cdEl) continue;
        const endsAt = new Date(pool.reset_time);
        if (!isNaN(endsAt.getTime())) {
          countdowns[cdId] = { endsAt, el: cdEl };
        }
      }
    }
  }

  // Register open drawer countdowns if drawer is active
  if (drawerAccount) {
    registerDrawerCountdowns(drawerAccount);
  }
}

function registerDrawerCountdowns(acc) {
  const drawerPools = [
    { id: 'gemini_5h',     get: (a) => a.pools?.gemini_5h || a.pools?.gemini_flash },
    { id: 'gemini_weekly', get: (a) => a.pools?.gemini_weekly || a.pools?.gemini_pro },
    { id: 'claude_5h',     get: (a) => a.pools?.claude_5h || a.pools?.claude_gpt },
    { id: 'claude_weekly', get: (a) => a.pools?.claude_weekly },
    { id: 'argon_weekly',  get: (a) => a.pools?.argon_weekly },
  ];

  for (const dp of drawerPools) {
    const pool = dp.get(acc);
    if (!pool || pool.pct >= 100 || !pool.reset_time) continue;
    const cdId = `cd-dr-${dp.id}`;
    const cdEl = document.getElementById(cdId);
    if (!cdEl) continue;
    const endsAt = new Date(pool.reset_time);
    if (!isNaN(endsAt.getTime())) {
      countdowns[cdId] = { endsAt, el: cdEl, isDrawer: true };
    }
  }
}

/* ── Main Dashboard Render ───────────────────────────────────────────── */
function renderDashboard(data) {
  if (data.theme) {
    syncTheme(data.theme);
  }

  const rpcOk = data.rpc_ok !== false;
  const timeFormatted = formatTime(data.updated_at);

  el('status-dot').className     = `status-dot ${rpcOk ? 'live' : 'stale'}`;
  el('status-label').textContent = `${rpcOk ? 'Live' : 'Cached'} · ${timeFormatted}`;
  setText('ts', timeFormatted);

  renderHealthPills(data);

  const container = el('cards');
  const query     = filterText.trim().toLowerCase();
  const allAccounts = data.accounts || [];
  const accounts  = allAccounts.filter(a =>
    a && a.email && (!query || a.email.toLowerCase().includes(query))
  );

  if (!allAccounts.length) {
    container.innerHTML = `<div class="empty-msg">No accounts recorded yet.<br>Start a chat in Antigravity to record the first snapshot.</div>`;
    return;
  }

  if (query && !accounts.length) {
    container.innerHTML = `<div class="empty-msg">No accounts match "${esc(query)}".</div>`;
    return;
  }

  const visibleGroups = MODEL_GROUPS.filter(g => selectedModels.has(g.id));

  if (!visibleGroups.length) {
    container.innerHTML = `<div class="empty-msg">No models selected.<br>Select Gemini, Argon, or Claude above to view quotas.</div>`;
    return;
  }

  container.innerHTML = visibleGroups.map(grp => renderGroup(grp, accounts)).join('');

  // Row interactions & keyboard accessibility
  for (const tr of container.querySelectorAll('tr[data-email]')) {
    const openDetail = () => {
      const acc = data.accounts.find(a => a && a.email === tr.dataset.email);
      if (acc) openDrawer(acc, tr);
    };
    tr.addEventListener('click', openDetail);
    tr.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openDetail();
      }
    });
  }

  registerCountdowns(accounts);

  if (drawerAccount) {
    const refreshed = data.accounts.find(a => a && a.email === drawerAccount.email);
    if (refreshed) {
      drawerAccount = refreshed;
      renderDrawerBody(refreshed);
    }
  }
}

/* ── Drawer Detail View ──────────────────────────────────────────────── */
function openDrawer(acc, triggerEl) {
  drawerAccount = acc;
  drawerTrigger = triggerEl || null;
  el('drawer-title').textContent = acc.email;
  renderDrawerBody(acc);

  const drawer = el('drawer');
  const overlay = el('drawer-overlay');
  drawer.classList.add('open');
  overlay.classList.add('open');
  drawer.setAttribute('aria-hidden', 'false');

  requestAnimationFrame(() => el('drawer-close').focus());
}

function closeDrawer() {
  const drawer = el('drawer');
  const overlay = el('drawer-overlay');
  drawer.classList.remove('open');
  overlay.classList.remove('open');
  drawer.setAttribute('aria-hidden', 'true');

  const trigger = drawerTrigger;
  const targetEmail = drawerAccount?.email;
  drawerAccount = null;
  drawerTrigger = null;

  if (trigger && document.contains(trigger)) {
    trigger.focus();
  } else if (targetEmail) {
    const container = el('cards');
    const freshTr = container ? container.querySelector(`tr[data-email="${CSS.escape(targetEmail)}"]`) : null;
    if (freshTr) freshTr.focus();
  }
}

function renderDrawerBody(acc) {
  const lastSeen = acc.last_seen_utc ? formatDateTime(acc.last_seen_utc) : '—';

  const drawerPools = [
    { id: 'gemini_5h',     label: 'Gemini 5-Hour', get: (a) => a.pools?.gemini_5h || a.pools?.gemini_flash, window: '5h' },
    { id: 'gemini_weekly', label: 'Gemini Weekly', get: (a) => a.pools?.gemini_weekly || a.pools?.gemini_pro, window: 'weekly' },
    { id: 'claude_5h',     label: 'Claude 5-Hour', get: (a) => a.pools?.claude_5h || a.pools?.claude_gpt, window: '5h' },
    { id: 'claude_weekly', label: 'Claude Weekly', get: (a) => a.pools?.claude_weekly, window: 'weekly' },
    { id: 'argon_weekly',  label: 'Argon Weekly',  get: (a) => a.pools?.argon_weekly, window: 'weekly' },
  ];

  const poolItems = drawerPools
    .filter(dp => dp.id !== 'argon_weekly' || Boolean(dp.get(acc)))
    .map(dp => {
      const pool = dp.get(acc);
      if (!pool) {
      return `
        <div class="dr-pool-item">
          <div class="dr-pool-top">
            <span class="dr-pool-name">${esc(dp.label)}</span>
            <span class="dr-pool-val pct-na" aria-label="Not available">—</span>
          </div>
          <div class="bar-track"><div class="bar-fill bar-na" style="width:0%"></div></div>
          <div class="dr-pool-bottom"><span>Window: ${esc(dp.window)}</span><span>N/A</span></div>
        </div>`;
    }

    const pct    = pool.pct ?? 0;
    const cls    = poolClass(pct);
    const cdId   = `cd-dr-${dp.id}`;
    const cdText = pct >= 100 ? 'Full' : (pool.countdown || 'Replenishing');
    const hasCd  = Boolean(pct < 100 && cdText && cdText !== 'Full' && cdText !== '✓ Ready');
    const cdCls  = hasCd ? 'dr-pool-cd cd-active' : (cdText === 'Full' || cdText === '✓ Ready' ? 'dr-pool-cd cd-ready' : 'dr-pool-cd');
    const semCls = cls === 'crit' ? 'critical' : cls === 'warn' ? 'warning' : 'healthy';

    return `
      <div class="dr-pool-item">
        <div class="dr-pool-top">
          <span class="dr-pool-name">${esc(dp.label)}</span>
          <span class="dr-pool-val pct-${cls}" aria-label="${pct}% remaining (${semCls})">${pct}%</span>
        </div>
        <div class="bar-track"><div class="bar-fill bar-${cls}" style="width:${pct}%"></div></div>
        <div class="dr-pool-bottom">
          <span>${esc(pool.display_name || dp.label)}</span>
          <span class="${cdCls}" id="${esc(cdId)}">${esc(cdText)}</span>
        </div>
      </div>`;
  }).join('');

  const isSwitchRecommended = (lastData?.switch_recommendations || []).includes(acc.email);
  const recBanner = (!acc.is_active && isSwitchRecommended)
    ? `<div class="dr-rec-box">💡 Optimal Quota — Recommended account to switch to.</div>`
    : '';

  el('drawer-body').innerHTML = `
    <div>
      <div class="dr-sec-title">Account Info</div>
      <div class="dr-meta-item"><span class="dr-meta-label">Plan</span><span class="dr-meta-val">${esc(acc.plan || 'Pro')}</span></div>
      <div class="dr-meta-item"><span class="dr-meta-label">Session</span><span class="dr-meta-val">${acc.is_active ? 'Active' : 'Offline'}</span></div>
      <div class="dr-meta-item"><span class="dr-meta-label">Last Seen</span><span class="dr-meta-val">${esc(lastSeen)}</span></div>
    </div>
    <div>
      <div class="dr-sec-title">Pool Breakdown</div>
      ${poolItems}
    </div>
    ${recBanner}
  `;

  registerDrawerCountdowns(acc);
}

/* ── Error & Loading UI ──────────────────────────────────────────────── */
function showError(msg) {
  el('error-banner').innerHTML   = `<div class="banner">⚠ ${esc(msg)}</div>`;
  el('status-dot').className     = 'status-dot error';
  el('status-label').textContent = 'Error';
}

function clearError() {
  el('error-banner').innerHTML = '';
}

function setLoading() {
  el('status-dot').className     = 'status-dot loading';
  el('status-label').textContent = 'Refreshing…';
}

/* ── Data Fetch ──────────────────────────────────────────────────────── */
async function fetchQuota() {
  setLoading();
  try {
    const res = await fetch(API, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    lastData = data;
    clearError();
    renderDashboard(data);
  } catch (err) {
    showError(`Failed to load (${err.message})`);
    if (lastData) renderDashboard(lastData);
  }
}

function scheduleRefresh() {
  clearInterval(pollingTimer);
  pollingTimer = setInterval(fetchQuota, POLL_MS);
}

/* ── Filter & Search Handlers ────────────────────────────────────────── */
function updateSearchClear() {
  const btn = el('search-clear');
  if (btn) btn.style.display = filterText ? 'flex' : 'none';
}

el('search').addEventListener('input', (e) => {
  filterText = e.target.value;
  updateSearchClear();
  if (lastData) renderDashboard(lastData);
});

el('search-clear').addEventListener('click', () => {
  filterText = '';
  el('search').value = '';
  updateSearchClear();
  el('search').focus();
  if (lastData) renderDashboard(lastData);
});

el('refresh-btn').addEventListener('click', () => {
  fetchQuota();
  scheduleRefresh();
});

/* ── Model Tabs Handler & WAI-ARIA Navigation ────────────────────────── */
/* ── Model Multi-select Filter Handler ────────────────────────────────── */
function toggleModel(modelId) {
  if (selectedModels.has(modelId)) {
    selectedModels.delete(modelId);
  } else {
    selectedModels.add(modelId);
  }

  updateFilterUI();

  if (lastData) {
    renderDashboard(lastData);
  } else {
    el('cards').innerHTML = renderSkeleton();
  }
}

function updateFilterUI() {
  const container = el('model-tabs');
  if (!container) return;
  for (const btn of container.querySelectorAll('.tab-btn')) {
    const isSelected = selectedModels.has(btn.dataset.model);
    btn.classList.toggle('active', isSelected);
    btn.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
  }
}

el('model-tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab-btn');
  if (btn && btn.dataset.model) {
    toggleModel(btn.dataset.model);
  }
});

// Arrow key navigation across filter buttons
el('model-tabs').addEventListener('keydown', (e) => {
  const tabs = Array.from(el('model-tabs').querySelectorAll('.tab-btn'));
  const current = document.activeElement;
  const idx = tabs.indexOf(current);
  if (idx === -1) return;

  let nextIdx = null;
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
    nextIdx = (idx + 1) % tabs.length;
  } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
    nextIdx = (idx - 1 + tabs.length) % tabs.length;
  } else if (e.key === 'Home') {
    nextIdx = 0;
  } else if (e.key === 'End') {
    nextIdx = tabs.length - 1;
  }

  if (nextIdx !== null) {
    e.preventDefault();
    tabs[nextIdx].focus();
  }
});

/* ── Global Keyboard Shortcuts ───────────────────────────────────────── */
document.addEventListener('keydown', (e) => {
  const isDrawerOpen = el('drawer')?.classList.contains('open');

  // When modal drawer is open, trap shortcuts to modal only
  if (isDrawerOpen) {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeDrawer();
    }
    return;
  }

  const isInput = document.activeElement &&
    ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName);

  // ⌘K or Ctrl+K or /: Focus search
  if (((e.metaKey || e.ctrlKey) && e.key === 'k') || (e.key === '/' && !isInput)) {
    e.preventDefault();
    el('search').focus();
    el('search').select();
    return;
  }

  // R: Manual refresh
  if (e.key === 'r' && !e.metaKey && !e.ctrlKey && !isInput) {
    fetchQuota();
    scheduleRefresh();
    return;
  }

  // 1, 2, 3: Toggle Gemini, Argon, Claude
  if (!isInput && !e.metaKey && !e.ctrlKey) {
    if (e.key === '1') toggleModel('gemini');
    else if (e.key === '2') toggleModel('argon');
    else if (e.key === '3') toggleModel('claude');
  }

  // Escape: Clear search or blur
  if (e.key === 'Escape') {
    if (filterText) {
      filterText = '';
      el('search').value = '';
      updateSearchClear();
      if (lastData) renderDashboard(lastData);
    } else {
      el('search').blur();
    }
  }
});

/* ── Drawer Accessibility & Focus Trap ───────────────────────────────── */
el('drawer-close').addEventListener('click', closeDrawer);
el('drawer-overlay').addEventListener('click', closeDrawer);

el('drawer').addEventListener('keydown', (e) => {
  if (e.key !== 'Tab') return;
  const focusable = Array.from(
    el('drawer').querySelectorAll('button, [tabindex]:not([tabindex="-1"]), a[href]')
  ).filter(node => !node.disabled);

  if (!focusable.length) return;
  const first = focusable[0];
  const last  = focusable[focusable.length - 1];

  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
});

/* ── Theme Synchronization with Antigravity ─────────────────────────── */
function syncTheme(themeConfig) {
  if (!themeConfig) return;
  const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const activePreset = isDark
    ? (themeConfig.preset_dark || 'One Dark Pro')
    : (themeConfig.preset_light || 'Default Light');

  const slug = activePreset
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');

  document.documentElement.setAttribute('data-theme', slug);
  try { localStorage.setItem('agy_theme', slug); } catch { /* ignore */ }

  const badge = el('theme-badge');
  if (badge) {
    badge.textContent = activePreset;
    badge.title = `Theme synchronized with Antigravity: ${activePreset}`;
  }
}

// React dynamically to host OS/IDE light/dark changes
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (lastData?.theme) {
    syncTheme(lastData.theme);
  }
});

// React to possible postMessage events from host window
window.addEventListener('message', (e) => {
  if (e.data && e.data.theme) {
    syncTheme(typeof e.data.theme === 'string' ? { preset_dark: e.data.theme, preset_light: e.data.theme } : e.data.theme);
  }
});

/* ── Initialization ──────────────────────────────────────────────────── */
el('cards').innerHTML = renderSkeleton();
fetchQuota();
scheduleRefresh();
setInterval(tickCountdowns, TICK_MS);
