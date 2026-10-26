'use strict';

/* ── Constants ─────────────────────────────────────────────────────── */
const POLL_INTERVAL_MS = 15_000;
const TICK_INTERVAL_MS = 1_000;
const API_PATH         = '/api/quota';

const CATEGORIES = [
  {
    id: 'gemini',
    title: 'Gemini Models',
    icon: '✨',
    getPools: (acc) => ({
      h5: acc.pools.gemini_5h || acc.pools.gemini_flash,
      wk: acc.pools.gemini_weekly || acc.pools.gemini_pro,
    }),
  },
  {
    id: 'argon',
    title: 'Argon Models',
    icon: '⚡',
    getPools: (acc) => ({
      h5: null, // Argon has no 5h bucket in Pro plan
      wk: acc.pools.argon_weekly,
    }),
  },
  {
    id: 'claude',
    title: 'Claude Models',
    icon: '🧠',
    getPools: (acc) => ({
      h5: acc.pools.claude_5h || acc.pools.claude_gpt,
      wk: acc.pools.claude_weekly,
    }),
  },
];

/* ── State ─────────────────────────────────────────────────────────── */
let lastData   = null;
let countdowns = {};  // key -> { endsAt: Date, el: Element }

/* ── Countdown ticker ──────────────────────────────────────────────── */
function tickCountdowns() {
  const now = Date.now();
  for (const [key, info] of Object.entries(countdowns)) {
    if (!info.el || !document.contains(info.el)) {
      delete countdowns[key];
      continue;
    }
    const diffMs = info.endsAt - now;
    if (diffMs <= 0) {
      info.el.textContent = '✅ Đã hồi đầy';
    } else {
      const h = Math.floor(diffMs / 3_600_000);
      const m = Math.floor((diffMs % 3_600_000) / 60_000);
      const s = Math.floor((diffMs % 60_000) / 1_000);
      info.el.textContent = h > 0
        ? `hồi sau ${h}h${String(m).padStart(2, '0')}m`
        : `hồi sau ${String(m).padStart(2, '0')}m${String(s).padStart(2, '0')}s`;
    }
  }
}

/* ── Rendering helpers ─────────────────────────────────────────────── */
function renderQuotaCell(catId, email, windowLabel, pool, isNA = false) {
  const cdId = `cd-${catId}-${email.replace(/[@.]/g, '_')}-${windowLabel.toLowerCase()}`;

  if (isNA) {
    return `
      <div class="quota-cell">
        <div class="quota-cell-header">
          <span class="quota-cell-window">${windowLabel}</span>
          <span class="quota-cell-pct" style="color:var(--fg-dim)">—</span>
        </div>
        <div class="bar-track"><div class="bar-fill bar-na" style="width:0%"></div></div>
        <div class="quota-cell-cd" style="color:var(--fg-dim)">Chỉ có Weekly</div>
      </div>`;
  }

  if (!pool) {
    return `
      <div class="quota-cell">
        <div class="quota-cell-header">
          <span class="quota-cell-window">${windowLabel}</span>
          <span class="quota-cell-pct" style="color:var(--fg-dim)">—</span>
        </div>
        <div class="bar-track"><div class="bar-fill bar-na" style="width:0%"></div></div>
        <div class="quota-cell-cd" style="color:var(--fg-dim)">Chưa snapshot</div>
      </div>`;
  }

  const pct = pool.pct ?? 0;
  const barClass = `bar-${pool.status || 'unknown'}`;
  const cdText = pool.countdown || '';

  return `
    <div class="quota-cell">
      <div class="quota-cell-header">
        <span class="quota-cell-window">${windowLabel}</span>
        <span class="quota-cell-pct">${pct}%</span>
      </div>
      <div class="bar-track">
        <div class="bar-fill ${barClass}" style="width:${pct}%"></div>
      </div>
      <div class="quota-cell-cd" id="${cdId}">${cdText}</div>
    </div>`;
}

function renderAccountRow(cat, acc) {
  const { h5, wk } = cat.getPools(acc);
  const isArgon = cat.id === 'argon';

  let tagHtml = '';
  if (acc.is_active) {
    tagHtml = '<span class="account-tag tag-active">🔵 ACTIVE</span>';
  } else if (acc.status === 'ready') {
    tagHtml = '<span class="account-tag tag-ready">🟢 SẴN SÀNG</span>';
  } else if (acc.status === 'low') {
    tagHtml = '<span class="account-tag tag-low">🟡 CÒN ÍT</span>';
  } else if (acc.status === 'exhausted') {
    tagHtml = '<span class="account-tag tag-crit">⏳ ĐANG HỒI</span>';
  }

  const h5Cell = renderQuotaCell(cat.id, acc.email, '5-Hour', h5, isArgon);
  const wkCell = renderQuotaCell(cat.id, acc.email, 'Weekly', wk, false);

  return `
    <div class="account-row${acc.is_active ? ' active' : ''}">
      <div class="account-header-row">
        <span class="account-email" title="${acc.email}">${acc.is_active ? '🔵 ' : ''}${acc.email}</span>
        ${tagHtml}
      </div>
      <div class="quota-pair-row">
        ${h5Cell}
        ${wkCell}
      </div>
    </div>`;
}

function renderCategoryGroup(cat, accounts) {
  const rowsHtml = accounts.map(acc => renderAccountRow(cat, acc)).join('');

  return `
    <div class="category-group">
      <div class="category-header">
        <span class="category-title">${cat.icon} ${cat.title}</span>
        <span class="category-badge">${accounts.length} accounts</span>
      </div>
      <div class="accounts-list">
        ${rowsHtml || '<div style="padding:10px;color:var(--fg-dim);font-size:11px">Chưa có tài khoản</div>'}
      </div>
    </div>`;
}

function renderDashboard(data) {
  // Update timestamp
  const ts = new Date(data.updated_at);
  document.getElementById('ts').textContent =
    `Cập nhật: ${ts.toLocaleTimeString('vi-VN')}`;

  const container = document.getElementById('cards');
  if (!data.accounts || !data.accounts.length) {
    container.innerHTML =
      '<div style="color:var(--fg-dim);font-size:11px;padding:20px 0;text-align:center">Chưa có tài khoản nào trong cache.<br>Mở Antigravity và chat để ghi nhận lần đầu.</div>';
    return;
  }

  // Render Category Groups: Gemini Models -> Argon Models -> Claude Models
  container.className = 'category-container';
  container.innerHTML = CATEGORIES.map(cat => renderCategoryGroup(cat, data.accounts)).join('');

  // Register countdown elements for live ticking
  countdowns = {};
  for (const cat of CATEGORIES) {
    for (const acc of data.accounts) {
      const { h5, wk } = cat.getPools(acc);
      const pairs = [
        { pool: h5, window: '5-hour' },
        { pool: wk, window: 'weekly' },
      ];
      for (const { pool, window } of pairs) {
        if (!pool || pool.pct >= 100 || !pool.countdown) continue;
        if (pool.countdown.startsWith('✅')) continue;

        const elId = `cd-${cat.id}-${acc.email.replace(/[@.]/g, '_')}-${window}`;
        const el = document.getElementById(elId);
        if (!el) continue;

        // Extract hours & minutes from countdown text
        const match = pool.countdown.match(/(\d+)h(\d+)m/);
        if (match) {
          const totalSec = parseInt(match[1]) * 3600 + parseInt(match[2]) * 60;
          const endsAt = new Date(Date.now() + totalSec * 1000);
          countdowns[`${cat.id}:${acc.email}:${window}`] = { endsAt, el };
        }
      }
    }
  }

  // Footer switch recommendations
  const footerEl = document.getElementById('footer');
  const recs = data.switch_recommendations || [];
  footerEl.innerHTML = [
    recs.length
      ? `<div>💡 Gợi ý Switch: <span class="recommendation">${recs.join(', ')}</span></div>`
      : '',
    '<div class="safe-note">🔒 An toàn 100% — chỉ đọc 127.0.0.1 của Official App</div>',
  ].join('');
}

/* ── Error banner ──────────────────────────────────────────────────── */
function showError(msg) {
  document.getElementById('error-banner').innerHTML =
    `<div class="banner">⚠️ ${msg}</div>`;
}
function clearError() {
  document.getElementById('error-banner').innerHTML = '';
}

/* ── Data fetching ─────────────────────────────────────────────────── */
async function fetchQuota() {
  try {
    const res = await fetch(API_PATH, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    lastData = data;
    clearError();
    renderDashboard(data);
  } catch (err) {
    showError(`Không lấy được dữ liệu (${err.message}). Đang thử lại...`);
    if (lastData) renderDashboard(lastData);
  }
}

/* ── Init ──────────────────────────────────────────────────────────── */
fetchQuota();
setInterval(fetchQuota, POLL_INTERVAL_MS);
setInterval(tickCountdowns, TICK_INTERVAL_MS);
