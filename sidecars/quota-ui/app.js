'use strict';

/* ── Constants ────────────────────────────────────────────────────────── */
const POLL_MS = 15_000;
const TICK_MS = 1_000;
const API     = '/api/quota';

/* ── State ────────────────────────────────────────────────────────────── */
let lastData      = null;
let filterText    = '';
let countdowns    = {};   // key → { endsAt: Date, el: Element }
let drawerAccount = null;

/* ── Pool column definitions (order matches <thead>) ─────────────────── */
const COLUMNS = [
  { key: 'gemini_5h',    label: 'Gemini 5h'    },
  { key: 'gemini_weekly',label: 'Gemini Wk'    },
  { key: 'claude_5h',    label: 'Claude 5h'    },
  { key: 'claude_weekly',label: 'Claude Wk'    },
  { key: 'argon_weekly', label: 'Argon Wk'     },
];

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
  if (!text || text.startsWith('✓')) return 0;
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

/* ── Aggregate Summary ────────────────────────────────────────────────── */
function updateSummary(data) {
  const accounts = data.accounts || [];
  const byStatus = (s) => accounts.filter(a => a.status === s).length;
  setText('sum-total',    accounts.length);
  setText('sum-active',   byStatus('active'));
  setText('sum-ready',    byStatus('ready'));
  setText('sum-low',      byStatus('low'));
  setText('sum-exhausted', byStatus('exhausted'));
}

/* ── Pool cell rendering ─────────────────────────────────────────────── */
function renderPoolCell(acc, colKey, cdKey) {
  const pool = acc.pools[colKey];

  if (!pool) {
    return `<td>
      <div class="pool-cell">
        <span class="pool-pct pct-na">—</span>
        <div class="bar-track"><div class="bar-fill bar-empty" style="width:0%"></div></div>
        <span class="pool-cd">—</span>
      </div>
    </td>`;
  }

  const pct        = pool.pct ?? 0;
  const pctClass   = pct <= 5 ? 'pct-crit' : pct <= 20 ? 'pct-warn' : '';
  const barClass   = `bar-${pool.status || 'na'}`;
  const cdText     = pool.countdown || '';
  const cdId       = `cd-${cdKey}`;

  return `<td>
    <div class="pool-cell">
      <span class="pool-pct ${pctClass}">${pct}%</span>
      <div class="bar-track"><div class="bar-fill ${barClass}" style="width:${pct}%"></div></div>
      <span class="pool-cd" id="${cdId}">${cdText}</span>
    </div>
  </td>`;
}

/* ── Status badge ─────────────────────────────────────────────────────── */
const STATUS_MAP = {
  active:   { cls: 'badge-active',   label: 'Active'   },
  ready:    { cls: 'badge-ready',    label: 'Ready'    },
  low:      { cls: 'badge-low',      label: 'Low'      },
  exhausted:{ cls: 'badge-exhausted',label: 'Depleted' },
  unknown:  { cls: 'badge-unknown',  label: 'Unknown'  },
};
function renderBadge(status) {
  const s = STATUS_MAP[status] || STATUS_MAP.unknown;
  return `<span class="status-badge ${s.cls}">${s.label}</span>`;
}

/* ── Table row ────────────────────────────────────────────────────────── */
function renderRow(acc) {
  const emailKey = acc.email.replace(/[@.]/g, '_');
  const cells    = COLUMNS.map(col =>
    renderPoolCell(acc, col.key, `${emailKey}-${col.key}`)
  ).join('');

  return `<tr
    class="${acc.is_active ? 'row-active' : ''}"
    data-email="${acc.email}"
  >
    <td class="td-account">
      <div class="account-cell">
        <span class="account-email" title="${acc.email}">${acc.email}</span>
        <span class="account-plan">${acc.plan || 'Pro'}</span>
      </div>
    </td>
    ${cells}
    <td>${renderBadge(acc.status)}</td>
  </tr>`;
}

/* ── Countdown registration ────────────────────────────────────────────── */
function registerCountdowns(accounts) {
  countdowns = {};
  for (const acc of accounts) {
    const emailKey = acc.email.replace(/[@.]/g, '_');
    for (const col of COLUMNS) {
      const pool = acc.pools[col.key];
      if (!pool || pool.pct >= 100 || !pool.countdown) continue;
      const cdId  = `cd-${emailKey}-${col.key}`;
      const cdEl  = document.getElementById(cdId);
      if (!cdEl) continue;
      const ms = parseCountdownToMs(pool.countdown);
      if (ms > 0) {
        countdowns[cdId] = { endsAt: new Date(Date.now() + ms), el: cdEl };
      }
    }
  }
}

/* ── Main render ─────────────────────────────────────────────────────── */
function renderTable(data) {
  const tbody = el('table-body');
  const query = filterText.trim().toLowerCase();
  const accounts = (data.accounts || []).filter(a =>
    !query || a.email.toLowerCase().includes(query)
  );

  if (!accounts.length) {
    tbody.innerHTML = `<tr class="row-loading"><td colspan="7">${
      query ? 'No accounts match the filter.' : 'No accounts in cache yet. Open Antigravity and chat to record the first snapshot.'
    }</td></tr>`;
    return;
  }

  tbody.innerHTML = accounts.map(renderRow).join('');

  // Attach row click → drawer
  for (const tr of tbody.querySelectorAll('tr[data-email]')) {
    tr.addEventListener('click', () => {
      const acc = data.accounts.find(a => a.email === tr.dataset.email);
      if (acc) openDrawer(acc);
    });
  }

  registerCountdowns(accounts);
}

function renderDashboard(data) {
  // Refresh status
  el('status-dot').className   = 'status-dot live';
  el('status-label').textContent = `Live · ${new Date(data.updated_at).toLocaleTimeString('vi-VN')}`;
  setText('ts', new Date(data.updated_at).toLocaleTimeString('vi-VN'));

  updateSummary(data);
  renderTable(data);

  // If drawer open, refresh its data
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
      <div class="dr-meta"><span class="dr-meta-key">Status</span>${renderBadge(acc.status)}</div>
      <div class="dr-meta"><span class="dr-meta-key">Last seen</span><span class="dr-meta-val">${lastSeen}</span></div>
    </div>`;

  const poolRows = COLUMNS.map(col => {
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

  el('drawer-body').innerHTML = [meta,
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
    if (lastData) renderTable(lastData);
  }
}

/* ── Search / filter ─────────────────────────────────────────────────── */
el('search').addEventListener('input', (e) => {
  filterText = e.target.value;
  if (lastData) renderTable(lastData);
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
