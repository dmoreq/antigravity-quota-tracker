'use strict';

/* ── Constants ────────────────────────────────────────────────────────── */
const POLL_MS = 15_000;
const TICK_MS = 1_000;
const API     = '/api/quota';

/* ── Model Groups Definition ─────────────────────────────────────────── */
const MODEL_GROUPS = [
  {
    id: 'gemini',
    title: 'Gemini Model',
    icon: '✨',
    get5h: (acc) => acc.pools.gemini_5h || acc.pools.gemini_flash,
    getWk: (acc) => acc.pools.gemini_weekly || acc.pools.gemini_pro,
  },
  {
    id: 'argon',
    title: 'Argon Model',
    icon: '⚡',
    get5h: () => null, // Argon has no 5h bucket in Pro plan
    getWk: (acc) => acc.pools.argon_weekly,
  },
  {
    id: 'claude',
    title: 'Claude Model',
    icon: '🧠',
    get5h: (acc) => acc.pools.claude_5h || acc.pools.claude_gpt,
    getWk: (acc) => acc.pools.claude_weekly,
  },
];

/* ── State ────────────────────────────────────────────────────────────── */
let lastData      = null;
let filterText    = '';
let countdowns    = {};   // cdId → { endsAt: Date, el: Element }
let drawerAccount = null;

/* ── Countdown helpers ────────────────────────────────────────────────── */
function formatDiff(ms) {
  if (ms <= 0) return '✓ Replenished';
  const totalMin = Math.floor(ms / 60_000);
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  const s = Math.floor((ms % 60_000) / 1_000);
  if (d > 0) return `${d}d ${h}h ${String(m).padStart(2, '0')}m`;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`;
}

function parseCountdownToMs(text) {
  if (!text || text.startsWith('✓') || text.startsWith('✅')) return 0;
  const dMatch = text.match(/(\d+)d\s+(\d+)h\s+(\d+)m/);
  const hMatch = !dMatch && text.match(/(\d+)h\s+(\d+)m/);
  const mMatch = !dMatch && !hMatch && text.match(/(\d+)m\s+(\d+)s/);
  if (dMatch) return (parseInt(dMatch[1]) * 86400 + parseInt(dMatch[2]) * 3600 + parseInt(dMatch[3]) * 60) * 1000;
  if (hMatch) return (parseInt(hMatch[1]) * 3600 + parseInt(hMatch[2]) * 60) * 1000;
  if (mMatch) return (parseInt(mMatch[1]) * 60 + parseInt(mMatch[2])) * 1000;
  return 0;
}

function tickCountdowns() {
  const now = Date.now();
  for (const [key, info] of Object.entries(countdowns)) {
    if (!info.el || !document.contains(info.el)) { delete countdowns[key]; continue; }
    info.el.textContent = formatDiff(info.endsAt - now);
  }
}

/* ── DOM helpers ─────────────────────────────────────────────────────── */
function el(id)     { return document.getElementById(id); }
function setText(id, v) { const e = el(id); if (e) e.textContent = v; }

/* ── Pool cell rendering ─────────────────────────────────────────────── */
function renderPoolCell(pool, cdId, isNA = false) {
  if (isNA) {
    return `<td>
      <div class="pool-cell">
        <span class="pool-pct pct-na">—</span>
        <div class="bar-track"><div class="bar-fill bar-empty" style="width:0%"></div></div>
        <span class="pool-cd">—</span>
      </div>
    </td>`;
  }

  if (!pool) {
    return `<td>
      <div class="pool-cell">
        <span class="pool-pct pct-na">—</span>
        <div class="bar-track"><div class="bar-fill bar-empty" style="width:0%"></div></div>
        <span class="pool-cd">—</span>
      </div>
    </td>`;
  }

  const pct      = pool.pct ?? 0;
  const pctClass = pct <= 5 ? 'pct-crit' : pct <= 20 ? 'pct-warn' : '';
  const barClass = `bar-${pool.status || 'na'}`;
  const cdText   = pool.countdown || '';

  return `<td>
    <div class="pool-cell">
      <span class="pool-pct ${pctClass}">${pct}%</span>
      <div class="bar-track"><div class="bar-fill ${barClass}" style="width:${pct}%"></div></div>
      <span class="pool-cd" id="${cdId}">${cdText}</span>
    </div>
  </td>`;
}

/* ── Render Group ─────────────────────────────────────────────────────── */
function renderGroup(grp, accounts) {
  const rows = accounts.map(acc => {
    const emailKey = acc.email.replace(/[@.]/g, '_');
    const p5h = grp.get5h(acc);
    const pwk = grp.getWk(acc);
    const cd5h = `cd-${grp.id}-${emailKey}-5h`;
    const cdwk = `cd-${grp.id}-${emailKey}-wk`;

    const td5h = renderPoolCell(p5h, cd5h, grp.id === 'argon');
    const tdwk = renderPoolCell(pwk, cdwk, false);

    const planLabel = acc.is_active
      ? '<span class="account-plan plan-active">Active</span>'
      : `<span class="account-plan">${acc.plan || 'Pro'}</span>`;

    return `<tr class="${acc.is_active ? 'row-active' : ''}" data-email="${acc.email}">
      <td class="td-account">
        <div class="account-cell">
          <span class="account-email" title="${acc.email}">${acc.email}</span>
          ${planLabel}
        </div>
      </td>
      ${td5h}
      ${tdwk}
    </tr>`;
  }).join('');

  return `
    <section class="model-group" id="grp-${grp.id}">
      <div class="group-header">
        <div class="group-title">
          <span class="group-icon">${grp.icon}</span>
          <span>${grp.title}</span>
        </div>
        <span class="group-badge">${accounts.length} accounts</span>
      </div>
      <table class="mini-table">
        <thead>
          <tr>
            <th class="th-acct">Account</th>
            <th class="th-pool">5-Hour</th>
            <th class="th-pool">Weekly</th>
          </tr>
        </thead>
        <tbody>
          ${rows || '<tr class="row-loading"><td colspan="3">No accounts match the filter.</td></tr>'}
        </tbody>
      </table>
    </section>
  `;
}

/* ── Countdown registration ────────────────────────────────────────────── */
function registerCountdowns(accounts) {
  countdowns = {};
  for (const grp of MODEL_GROUPS) {
    for (const acc of accounts) {
      const emailKey = acc.email.replace(/[@.]/g, '_');
      const pools = [
        { pool: grp.get5h(acc), key: '5h' },
        { pool: grp.getWk(acc), key: 'wk' },
      ];
      for (const { pool, key } of pools) {
        if (!pool || pool.pct >= 100 || !pool.countdown) continue;
        const cdId = `cd-${grp.id}-${emailKey}-${key}`;
        const cdEl = document.getElementById(cdId);
        if (!cdEl) continue;
        const ms = parseCountdownToMs(pool.countdown);
        if (ms > 0) {
          countdowns[cdId] = { endsAt: new Date(Date.now() + ms), el: cdEl };
        }
      }
    }
  }
}

/* ── Main render ─────────────────────────────────────────────────────── */
function renderDashboard(data) {
  // Refresh status
  el('status-dot').className     = 'status-dot live';
  el('status-label').textContent = `Live · ${new Date(data.updated_at).toLocaleTimeString('vi-VN')}`;
  setText('ts', new Date(data.updated_at).toLocaleTimeString('vi-VN'));

  const container = el('cards');
  const query = filterText.trim().toLowerCase();
  const accounts = (data.accounts || []).filter(a =>
    !query || a.email.toLowerCase().includes(query)
  );

  if (!data.accounts || !data.accounts.length) {
    container.innerHTML = `<div class="row-loading">No accounts in cache yet. Open Antigravity and chat to record the first snapshot.</div>`;
    return;
  }

  // Render 3 Model Groups in order: Gemini Model -> Argon Model -> Claude Model
  container.innerHTML = MODEL_GROUPS.map(grp => renderGroup(grp, accounts)).join('');

  // Attach row click → drawer
  for (const tr of container.querySelectorAll('tr[data-email]')) {
    tr.addEventListener('click', () => {
      const acc = data.accounts.find(a => a.email === tr.dataset.email);
      if (acc) openDrawer(acc);
    });
  }

  registerCountdowns(accounts);

  // If drawer is open, refresh its data
  if (drawerAccount) {
    const refreshed = data.accounts.find(a => a.email === drawerAccount.email);
    if (refreshed) { drawerAccount = refreshed; renderDrawerBody(refreshed); }
  }
}

/* ── Drawer ──────────────────────────────────────────────────────────── */
function openDrawer(acc) {
  drawerAccount = acc;
  el('drawer-title').textContent = acc.email;
  renderDrawerBody(acc);
  el('drawer').classList.add('open');
  el('drawer-overlay').classList.add('open');
  el('drawer').setAttribute('aria-hidden', 'false');
}

function closeDrawer() {
  drawerAccount = null;
  el('drawer').classList.remove('open');
  el('drawer-overlay').classList.remove('open');
  el('drawer').setAttribute('aria-hidden', 'true');
}

function renderDrawerBody(acc) {
  const lastSeen = acc.last_seen_utc
    ? new Date(acc.last_seen_utc).toLocaleString('vi-VN')
    : '—';

  const meta = `
    <div>
      <div class="dr-section-label">Account Info</div>
      <div class="dr-meta"><span class="dr-meta-key">Plan</span><span class="dr-meta-val">${acc.plan || 'Pro'}</span></div>
      <div class="dr-meta"><span class="dr-meta-key">Active</span><span class="dr-meta-val">${acc.is_active ? 'Active' : 'Offline'}</span></div>
      <div class="dr-meta"><span class="dr-meta-key">Last seen</span><span class="dr-meta-val">${lastSeen}</span></div>
    </div>`;

  const drawerColumns = [
    { key: 'gemini_5h',     label: 'Gemini 5-Hour' },
    { key: 'gemini_weekly', label: 'Gemini Weekly' },
    { key: 'argon_weekly',  label: 'Argon Weekly'  },
    { key: 'claude_5h',     label: 'Claude 5-Hour' },
    { key: 'claude_weekly', label: 'Claude Weekly' },
  ];

  const poolRows = drawerColumns.map(col => {
    const pool = acc.pools[col.key];
    if (!pool) return `
      <div class="dr-pool-row">
        <span class="dr-pool-name">${col.label}</span>
        <div class="dr-pool-bar">
          <div class="dr-bar-label"><span>—</span><span>N/A</span></div>
          <div class="bar-track"><div class="bar-fill bar-empty" style="width:0"></div></div>
        </div>
      </div>`;

    const pct      = pool.pct ?? 0;
    const barClass = `bar-${pool.status || 'na'}`;
    return `
      <div class="dr-pool-row">
        <span class="dr-pool-name">${col.label}</span>
        <div class="dr-pool-bar">
          <div class="dr-bar-label">
            <span style="color:var(--fg-2)">${pool.display_name || col.label}</span>
            <span>${pct}%</span>
          </div>
          <div class="bar-track"><div class="bar-fill ${barClass}" style="width:${pct}%"></div></div>
          <span class="dr-pool-cd">${pool.countdown || '—'}</span>
        </div>
      </div>`;
  }).join('');

  const recBanner = !acc.is_active && acc.status === 'ready'
    ? `<div class="dr-rec-banner">💡 This account has sufficient quota and can be switched to.</div>`
    : '';

  el('drawer-body').innerHTML = [
    meta,
    `<div><div class="dr-section-label">Pool Breakdown</div>${poolRows}</div>`,
    recBanner,
  ].join('');
}

/* ── Error / status UI ───────────────────────────────────────────────── */
function showError(msg) {
  el('error-banner').innerHTML = `<div class="banner">⚠ ${msg}</div>`;
  el('status-dot').className   = 'status-dot error';
  el('status-label').textContent = 'Error';
}
function clearError() {
  el('error-banner').innerHTML = '';
}
function setLoading() {
  el('status-dot').className   = 'status-dot loading';
  el('status-label').textContent = 'Refreshing…';
}

/* ── Data fetch ──────────────────────────────────────────────────────── */
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
    showError(`Failed to fetch data (${err.message}). Retrying…`);
    if (lastData) renderDashboard(lastData);
  }
}

/* ── Search / filter ─────────────────────────────────────────────────── */
el('search').addEventListener('input', (e) => {
  filterText = e.target.value;
  if (lastData) renderDashboard(lastData);
});

// ⌘K / Ctrl+K focuses search
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
    e.preventDefault();
    el('search').focus();
    el('search').select();
  }
  if (e.key === 'Escape') {
    if (el('drawer').classList.contains('open')) closeDrawer();
    else { el('search').blur(); }
  }
});

/* ── Drawer close handlers ───────────────────────────────────────────── */
el('drawer-close').addEventListener('click', closeDrawer);
el('drawer-overlay').addEventListener('click', closeDrawer);

/* ── Init ────────────────────────────────────────────────────────────── */
fetchQuota();
setInterval(fetchQuota, POLL_MS);
setInterval(tickCountdowns, TICK_MS);
