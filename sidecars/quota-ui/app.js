'use strict';

/* ── Constants ────────────────────────────────────────────────────────── */
const POLL_MS = 15_000;
const TICK_MS = 1_000;
const API     = '/api/quota';

/* ── Model Groups ─────────────────────────────────────────────────────── */
const MODEL_GROUPS = [
  {
    id: 'gemini', title: 'Gemini Models', icon: '✦', has5h: true,
    get5h: (acc) => acc.pools.gemini_5h || acc.pools.gemini_flash,
    getWk: (acc) => acc.pools.gemini_weekly || acc.pools.gemini_pro,
  },
  {
    id: 'argon', title: 'Argon Models', icon: '◈', has5h: false,
    get5h: () => null,
    getWk: (acc) => acc.pools.argon_weekly,
  },
  {
    id: 'claude', title: 'Claude Models', icon: '◆', has5h: true,
    get5h: (acc) => acc.pools.claude_5h || acc.pools.claude_gpt,
    getWk: (acc) => acc.pools.claude_weekly,
  },
];

/* ── State ────────────────────────────────────────────────────────────── */
let lastData      = null;
let filterText    = '';
let countdowns    = {};
let drawerAccount = null;
let drawerTrigger = null;
let pollingTimer  = null;

/* ── Unified pool classification (fixes threshold mismatch) ───────────── */
function poolClass(pct) {
  if (pct <= 10) return 'crit';
  if (pct <= 30) return 'warn';
  return 'ok';
}

/* Fix #12 — glyph prefix for color-blind accessibility */
function poolGlyph(pct) {
  if (pct <= 10) return '▲▲ ';
  if (pct <= 30) return '▲ ';
  return '';
}

/* ── Countdown helpers ────────────────────────────────────────────────── */
function formatDiff(ms) {
  if (ms <= 0) return '✓ Ready';
  const totalMin = Math.floor(ms / 60_000);
  const d  = Math.floor(totalMin / 1440);
  const h  = Math.floor((totalMin % 1440) / 60);
  const m  = totalMin % 60;
  const s  = Math.floor((ms % 60_000) / 1_000);
  if (d > 0) return `${d}d ${h}h ${String(m).padStart(2,'0')}m`;
  if (h > 0) return `${h}h ${String(m).padStart(2,'0')}m`;
  return `${String(m).padStart(2,'0')}m ${String(s).padStart(2,'0')}s`;
}

function tickCountdowns() {
  const now = Date.now();
  for (const [key, info] of Object.entries(countdowns)) {
    if (!info.el || !document.contains(info.el)) { delete countdowns[key]; continue; }
    info.el.textContent = formatDiff(info.endsAt - now);
  }
}

/* ── DOM helpers ─────────────────────────────────────────────────────── */
function el(id)         { return document.getElementById(id); }
function setText(id, v) { const e = el(id); if (e) e.textContent = v; }

/* ── Fix #4 — Inline health pills in topbar ───────────────────────────── */
function renderHealthPills(data) {
  const accounts  = data.accounts || [];
  const byStatus  = (s) => accounts.filter(a => a.status === s).length;
  const active    = byStatus('active');
  const ready     = byStatus('ready');
  const low       = byStatus('low');
  const exhausted = byStatus('exhausted');

  const parts = [];
  if (active > 0)    parts.push(`<span class="hp hp-active">${active} Active</span>`);
  if (ready > 0)     parts.push(`<span class="hp hp-ok">${ready} Ready</span>`);
  if (low > 0)       parts.push(`<span class="hp hp-warn">${low} Low</span>`);
  if (exhausted > 0) parts.push(`<span class="hp hp-crit">${exhausted} Depleted</span>`);

  const pillsEl = el('health-pills');
  if (pillsEl) pillsEl.innerHTML = parts.join('<span class="hp-sep">·</span>');

  /* Fix #10 — RPC failure indicator */
  const rpcEl = el('rpc-warn');
  if (rpcEl) rpcEl.style.display = data.rpc_ok === false ? 'inline' : 'none';
}

/* ── Pool cell rendering ─────────────────────────────────────────────── */
function renderPoolCell(pool, cdId, isNA = false) {
  /* Fix #1 — merge duplicate NA / null branches */
  if (isNA || !pool) {
    return `<td>
      <div class="pool-cell">
        <span class="pool-pct pct-na">—</span>
        <div class="bar-track"><div class="bar-fill bar-na" style="width:0%"></div></div>
        <span class="pool-cd">${isNA ? 'N/A' : '—'}</span>
      </div>
    </td>`;
  }

  const pct    = pool.pct ?? 0;
  const cls    = poolClass(pct);
  const glyph  = poolGlyph(pct);
  /* Fix #7 — suppress countdown when pct >= 100 */
  const cdText = (pct >= 100) ? '' : (pool.countdown || '');

  return `<td>
    <div class="pool-cell">
      <span class="pool-pct pct-${cls}">${glyph}${pct}%</span>
      <div class="bar-track"><div class="bar-fill bar-${cls}" style="width:${pct}%"></div></div>
      <span class="pool-cd" id="${cdId}">${cdText}</span>
    </div>
  </td>`;
}

/* ── Group rendering ─────────────────────────────────────────────────── */
function renderGroup(grp, accounts) {
  const rows = accounts.map(acc => {
    const emailKey = acc.email.replace(/[@.]/g, '_');
    const p5h  = grp.get5h(acc);
    const pwk  = grp.getWk(acc);
    const cd5h = `cd-${grp.id}-${emailKey}-5h`;
    const cdwk = `cd-${grp.id}-${emailKey}-wk`;

    /* Fix #2 — Argon: no 5h column rendered at all */
    const td5h = grp.has5h ? renderPoolCell(p5h, cd5h) : '';
    const tdwk = renderPoolCell(pwk, cdwk);

    /* Fix #5 — account plan vs. active label */
    const planText = acc.is_active ? 'Active' : (acc.plan || 'Pro');
    const planCls  = acc.is_active ? 'account-plan plan-active' : 'account-plan';

    return `<tr
      class="${acc.is_active ? 'row-active' : ''}"
      data-email="${acc.email}"
      role="button"
      tabindex="0"
      aria-label="Open detail for ${acc.email}"
    >
      <td class="td-account">
        <div class="account-cell">
          <span class="account-email" title="${acc.email}">${acc.email}</span>
          <span class="${planCls}">${planText}</span>
        </div>
      </td>
      ${td5h}
      ${tdwk}
    </tr>`;
  }).join('');

  const colCount = grp.has5h ? 3 : 2;
  const th5h     = grp.has5h ? `<th class="th-pool">5-Hour</th>` : '';

  return `
    <section class="model-group" id="grp-${grp.id}">
      <div class="group-header">
        <div class="group-title">
          <span class="group-icon">${grp.icon}</span>
          <span>${grp.title}</span>
        </div>
        <span class="group-badge">${accounts.length}</span>
      </div>
      <table class="mini-table">
        <thead>
          <tr>
            <th class="th-acct">Account</th>
            ${th5h}
            <th class="th-pool">Weekly</th>
          </tr>
        </thead>
        <tbody>
          ${rows || `<tr><td colspan="${colCount}" class="empty-cell">No accounts match filter.</td></tr>`}
        </tbody>
      </table>
    </section>
  `;
}

/* ── Fix #11 — Loading skeleton (first paint) ─────────────────────────── */
function renderSkeleton() {
  const skelRow = (cols) => {
    const poolCols = Array(cols).fill(`
      <td><div class="skel-pool">
        <div class="skel skel-pct"></div>
        <div class="skel skel-bar"></div>
        <div class="skel skel-cd"></div>
      </div></td>`).join('');
    return `<tr class="skeleton-row">
      <td class="td-account">
        <div class="skel skel-email"></div>
        <div class="skel skel-plan"></div>
      </td>
      ${poolCols}
    </tr>`;
  };

  return MODEL_GROUPS.map(grp => {
    const cols = grp.has5h ? 2 : 1;
    const th5h = grp.has5h ? '<th class="th-pool">5-Hour</th>' : '';
    return `
      <section class="model-group">
        <div class="group-header">
          <div class="group-title"><span class="group-icon">${grp.icon}</span><span>${grp.title}</span></div>
          <span class="group-badge">—</span>
        </div>
        <table class="mini-table">
          <thead><tr><th class="th-acct">Account</th>${th5h}<th class="th-pool">Weekly</th></tr></thead>
          <tbody>${skelRow(cols)}${skelRow(cols)}${skelRow(cols)}</tbody>
        </table>
      </section>`;
  }).join('');
}

/* ── Fix #1 — Countdown registration using raw reset_time ISO ─────────── */
function registerCountdowns(accounts) {
  countdowns = {};
  for (const grp of MODEL_GROUPS) {
    for (const acc of accounts) {
      const emailKey = acc.email.replace(/[@.]/g, '_');
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
}

/* ── Main render ─────────────────────────────────────────────────────── */
function renderDashboard(data) {
  /* Fix #10 — stale vs. live status */
  const rpcOk = data.rpc_ok !== false;
  el('status-dot').className     = `status-dot ${rpcOk ? 'live' : 'stale'}`;
  el('status-label').textContent = `${rpcOk ? 'Live' : 'Stale'} · ${new Date(data.updated_at).toLocaleTimeString('vi-VN')}`;
  setText('ts', new Date(data.updated_at).toLocaleTimeString('vi-VN'));

  /* Fix #4 — health pills */
  renderHealthPills(data);

  const container = el('cards');
  const query     = filterText.trim().toLowerCase();
  const accounts  = (data.accounts || []).filter(a =>
    !query || a.email.toLowerCase().includes(query)
  );

  if (!data.accounts || !data.accounts.length) {
    container.innerHTML = `<div class="empty-state">No accounts in cache yet.<br>Open Antigravity and start a chat to record the first snapshot.</div>`;
    return;
  }

  container.innerHTML = MODEL_GROUPS.map(grp => renderGroup(grp, accounts)).join('');

  /* Fix #9 — keyboard accessibility + focus tracking */
  for (const tr of container.querySelectorAll('tr[data-email]')) {
    const openDetail = () => {
      const acc = data.accounts.find(a => a.email === tr.dataset.email);
      if (acc) openDrawer(acc, tr);
    };
    tr.addEventListener('click', openDetail);
    tr.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(); }
    });
  }

  registerCountdowns(accounts);

  if (drawerAccount) {
    const refreshed = data.accounts.find(a => a.email === drawerAccount.email);
    if (refreshed) { drawerAccount = refreshed; renderDrawerBody(refreshed); }
  }
}

/* ── Drawer ──────────────────────────────────────────────────────────── */
function openDrawer(acc, triggerEl) {
  drawerAccount = acc;
  drawerTrigger = triggerEl || null;
  el('drawer-title').textContent = acc.email;
  renderDrawerBody(acc);
  el('drawer').classList.add('open');
  el('drawer-overlay').classList.add('open');
  el('drawer').setAttribute('aria-hidden', 'false');
  /* Fix #9 — move focus into drawer */
  requestAnimationFrame(() => el('drawer-close').focus());
}

function closeDrawer() {
  el('drawer').classList.remove('open');
  el('drawer-overlay').classList.remove('open');
  el('drawer').setAttribute('aria-hidden', 'true');
  /* Fix #9 — return focus to trigger */
  const trigger = drawerTrigger;
  drawerAccount = null;
  drawerTrigger = null;
  if (trigger && document.contains(trigger)) trigger.focus();
}

function renderDrawerBody(acc) {
  const lastSeen = acc.last_seen_utc
    ? new Date(acc.last_seen_utc).toLocaleString('vi-VN') : '—';

  const drawerColumns = [
    { key: 'gemini_5h',     label: 'Gemini 5h'    },
    { key: 'gemini_weekly', label: 'Gemini Weekly' },
    { key: 'argon_weekly',  label: 'Argon Weekly'  },
    { key: 'claude_5h',     label: 'Claude 5h'     },
    { key: 'claude_weekly', label: 'Claude Weekly' },
  ];

  const poolRows = drawerColumns.map(col => {
    const pool = acc.pools[col.key];
    if (!pool) return `
      <div class="dr-pool-row">
        <span class="dr-pool-name">${col.label}</span>
        <div class="dr-pool-bar">
          <div class="dr-bar-label"><span style="color:var(--fg-3)">N/A</span><span>—</span></div>
          <div class="bar-track"><div class="bar-fill bar-na" style="width:0"></div></div>
        </div>
      </div>`;

    const pct    = pool.pct ?? 0;
    const cls    = poolClass(pct);
    const glyph  = poolGlyph(pct);
    /* Fix #7 — suppress countdown when full */
    const cdText = pct >= 100 ? '' : (pool.countdown || '');

    return `
      <div class="dr-pool-row">
        <span class="dr-pool-name">${col.label}</span>
        <div class="dr-pool-bar">
          <div class="dr-bar-label">
            <span class="dr-pool-label-name">${pool.display_name || col.label}</span>
            <span class="pct-${cls}">${glyph}${pct}%</span>
          </div>
          <div class="bar-track"><div class="bar-fill bar-${cls}" style="width:${pct}%"></div></div>
          ${cdText ? `<span class="dr-pool-cd">${cdText}</span>` : ''}
        </div>
      </div>`;
  }).join('');

  const recBanner = !acc.is_active && acc.status === 'ready'
    ? `<div class="dr-rec-banner">💡 Sufficient quota — ready to switch to this account.</div>` : '';

  el('drawer-body').innerHTML = [
    `<div>
      <div class="dr-section-label">Account Info</div>
      <div class="dr-meta"><span class="dr-meta-key">Plan</span><span class="dr-meta-val">${acc.plan || 'Pro'}</span></div>
      <div class="dr-meta"><span class="dr-meta-key">Session</span><span class="dr-meta-val">${acc.is_active ? 'Active' : 'Offline'}</span></div>
      <div class="dr-meta"><span class="dr-meta-key">Last seen</span><span class="dr-meta-val">${lastSeen}</span></div>
    </div>`,
    `<div><div class="dr-section-label">Pool Breakdown</div>${poolRows}</div>`,
    recBanner,
  ].join('');
}

/* ── Error / loading UI ──────────────────────────────────────────────── */
function showError(msg) {
  el('error-banner').innerHTML  = `<div class="banner">⚠ ${msg}</div>`;
  el('status-dot').className    = 'status-dot error';
  el('status-label').textContent = 'Error';
}
function clearError() { el('error-banner').innerHTML = ''; }
function setLoading() {
  el('status-dot').className    = 'status-dot loading';
  el('status-label').textContent = 'Refreshing…';
}

/* ── Data fetch ──────────────────────────────────────────────────────── */
async function fetchQuota() {
  setLoading();
  try {
    const res  = await fetch(API, { cache: 'no-store' });
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

/* Fix #6 — Manual refresh with interval reset */
function scheduleRefresh() {
  clearInterval(pollingTimer);
  pollingTimer = setInterval(fetchQuota, POLL_MS);
}

/* ── Search clear button (Fix #6) ────────────────────────────────────── */
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

/* Fix #6 — Refresh button */
el('refresh-btn').addEventListener('click', () => {
  fetchQuota();
  scheduleRefresh();
});

/* ── Keyboard shortcuts ──────────────────────────────────────────────── */
document.addEventListener('keydown', (e) => {
  const inInput = document.activeElement.tagName === 'INPUT';

  /* ⌘K / Ctrl+K — focus search */
  if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
    e.preventDefault();
    el('search').focus();
    el('search').select();
    return;
  }
  /* R — manual refresh (not when typing) */
  if (e.key === 'r' && !e.metaKey && !e.ctrlKey && !inInput) {
    fetchQuota();
    scheduleRefresh();
    return;
  }
  /* Esc — close drawer or clear search */
  if (e.key === 'Escape') {
    if (el('drawer').classList.contains('open')) { closeDrawer(); return; }
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

/* ── Drawer event handlers ───────────────────────────────────────────── */
el('drawer-close').addEventListener('click', closeDrawer);
el('drawer-overlay').addEventListener('click', closeDrawer);

/* Fix #9 — Tab focus trap inside drawer */
el('drawer').addEventListener('keydown', (e) => {
  if (e.key !== 'Tab') return;
  const focusable = Array.from(
    el('drawer').querySelectorAll('button, [tabindex]:not([tabindex="-1"]), a[href]')
  ).filter(el => !el.disabled);
  if (!focusable.length) return;
  const first = focusable[0];
  const last  = focusable[focusable.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});

/* ── Init ────────────────────────────────────────────────────────────── */
/* Fix #11 — show skeleton before first data lands */
el('cards').innerHTML = renderSkeleton();

fetchQuota();
scheduleRefresh();
setInterval(tickCountdowns, TICK_MS);
