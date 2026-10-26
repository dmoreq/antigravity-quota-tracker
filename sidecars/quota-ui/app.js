'use strict';

/* ── Constants ─────────────────────────────────────────────────────── */
const POLL_INTERVAL_MS    = 15_000;
const TICK_INTERVAL_MS    = 1_000;
const API_URL             = `${window.location.origin}/api/quota`;

const POOL_LABELS = {
  gemini_5h:      'Gemini (5h)',
  gemini_flash:   'Gemini Flash (5h)',
  claude_5h:      'Claude / GPT (5h)',
  claude_gpt:     'Claude / GPT (5h)',
  gemini_weekly:  'Gemini (Weekly)',
  gemini_pro:     'Gemini Pro (Weekly)',
  claude_weekly:  'Claude / GPT (Weekly)',
  argon_weekly:   'Argon (Weekly)',
};

const PRIORITY_POOLS = ['gemini_5h','gemini_flash','claude_5h','claude_gpt','argon_weekly','gemini_weekly','claude_weekly'];

const STATUS_LABELS = {
  active:    { emoji: '🔵', text: 'ACTIVE',    badge: 'badge-active'    },
  ready:     { emoji: '🟢', text: 'SẴN SÀNG',  badge: 'badge-ready'     },
  low:       { emoji: '🟡', text: 'CÒN ÍT',    badge: 'badge-low'       },
  exhausted: { emoji: '⏳', text: 'ĐANG HỒI',  badge: 'badge-exhausted' },
  unknown:   { emoji: '⚪', text: '...',        badge: 'badge-unknown'   },
};

/* ── State ─────────────────────────────────────────────────────────── */
let lastData     = null;
let countdowns   = {};  // key → { endsAt: Date, el: Element }

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
        ? `hồi sau ${h}h${String(m).padStart(2,'0')}m`
        : `hồi sau ${String(m).padStart(2,'0')}m${String(s).padStart(2,'0')}s`;
    }
  }
}

/* ── Rendering helpers ─────────────────────────────────────────────── */
function barClass(status) {
  return `bar-${status}`;
}

function renderPool(email, key, pool) {
  const label     = POOL_LABELS[key] || pool.display_name || key;
  const pct       = pool.pct ?? 0;
  const countdownId = `cd-${email.replace(/[@.]/g,'_')}-${key}`;

  return `
    <div class="pool-row">
      <div class="pool-label-row">
        <span class="pool-name">${label}</span>
        <div class="pool-right">
          <span class="pool-pct">${pct}%</span>
          <span class="pool-cd" id="${countdownId}"></span>
        </div>
      </div>
      <div class="bar-track">
        <div class="bar-fill ${barClass(pool.status)}" style="width:${pct}%"></div>
      </div>
    </div>`;
}

function renderCard(acc) {
  const st    = STATUS_LABELS[acc.status] || STATUS_LABELS.unknown;
  const badge = `${st.emoji} ${st.text}`;

  // Sort pools by priority
  const poolKeys = PRIORITY_POOLS.filter(k => acc.pools[k]);

  const poolsHtml = poolKeys.map(k => renderPool(acc.email, k, acc.pools[k])).join('');

  return `
    <div class="card${acc.is_active ? ' active' : ''}">
      <div class="card-header">
        <span class="card-email" title="${acc.email}">${acc.email}</span>
        <span class="card-badge ${st.badge}">${badge}</span>
      </div>
      <div class="pools">${poolsHtml || '<span style="color:var(--fg-dim);font-size:10px">Chưa có dữ liệu pool</span>'}</div>
    </div>`;
}

function renderDashboard(data) {
  // Header timestamp
  const ts = new Date(data.updated_at);
  document.getElementById('ts').textContent =
    `Cập nhật: ${ts.toLocaleTimeString('vi-VN')}`;

  // Cards
  const cardsEl = document.getElementById('cards');
  cardsEl.innerHTML = data.accounts.length
    ? data.accounts.map(renderCard).join('')
    : '<div style="color:var(--fg-dim);font-size:11px;padding:20px 0;text-align:center">Chưa có tài khoản nào trong cache.<br>Mở Antigravity và chat để ghi nhận lần đầu.</div>';

  // Register countdowns for pool cells
  countdowns = {};
  for (const acc of data.accounts) {
    for (const [key, pool] of Object.entries(acc.pools)) {
      if (!pool.reset_local && pool.pct < 100) continue;
      const el = document.getElementById(`cd-${acc.email.replace(/[@.]/g,'_')}-${key}`);
      if (!el) continue;
      // Set static text first (from server)
      el.textContent = pool.countdown || '';
      // If not yet replenished, register live countdown
      if (pool.status !== 'replenished' && pool.countdown && !pool.countdown.startsWith('✅')) {
        const match = (pool.countdown || '').match(/(\d+)h(\d+)m/);
        if (match) {
          const endsAt = new Date(Date.now() + (parseInt(match[1]) * 3600 + parseInt(match[2]) * 60) * 1000);
          countdowns[`${acc.email}:${key}`] = { endsAt, el };
        }
      }
    }
  }

  // Footer
  const footerEl = document.getElementById('footer');
  const recs = data.switch_recommendations || [];
  footerEl.innerHTML = [
    recs.length
      ? `<div>💡 Gợi ý Switch: <span class="recommendation">${recs.join(', ')}</span></div>`
      : '',
    '<div class="safe-note">🔒 An toàn 100% — chỉ giao tiếp với 127.0.0.1 của Official App</div>',
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
    const res = await fetch(API_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    lastData = data;
    clearError();
    renderDashboard(data);
  } catch (err) {
    showError(`Không lấy được dữ liệu (${err.message}). Đang thử lại...`);
    if (lastData) renderDashboard(lastData); // keep stale view
  }
}

/* ── Init ──────────────────────────────────────────────────────────── */
fetchQuota();
setInterval(fetchQuota, POLL_INTERVAL_MS);
setInterval(tickCountdowns, TICK_INTERVAL_MS);
