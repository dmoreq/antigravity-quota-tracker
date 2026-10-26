/* eslint-disable */
'use strict';

/**
 * Quota Dashboard Sidecar — Node.js HTTP backend.
 * Serves the aux pane HTML and a /api/quota endpoint.
 * Uses only Node.js stdlib (http, fs, path, https, net). Zero npm dependencies.
 */

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const net   = require('net');
const os    = require('os');

const STATIC_DIR   = __dirname;
const SNAPSHOT_FILE = path.join(os.homedir(), '.antigravity_quota_snapshots.json');
const LS_ADDRESS   = process.env.ANTIGRAVITY_LS_ADDRESS  || '';
const CSRF_TOKEN   = process.env.ANTIGRAVITY_CSRF_TOKEN  || '';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
};

// ── Helpers ────────────────────────────────────────────────────────────────

function rpcPost(method, cb) {
  if (!LS_ADDRESS) return cb(null, null);

  const options = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-codeium-csrf-token': CSRF_TOKEN,
      'Content-Length': 2,
    },
  };

  // Support both http and https; language_server listens on http in recent builds
  const [host, port] = LS_ADDRESS.split(':');
  const transport    = (parseInt(port, 10) === 443 || LS_ADDRESS.startsWith('https')) ? https : http;

  Object.assign(options, {
    hostname: host,
    port:     parseInt(port, 10),
    path:     `/exa.language_server_pb.LanguageServerService/${method}`,
  });

  const req = transport.request(options, (res) => {
    let body = '';
    res.on('data', (d) => (body += d));
    res.on('end', () => {
      try { cb(null, JSON.parse(body)); }
      catch (e) { cb(null, null); }
    });
  });
  req.on('error', () => cb(null, null));
  req.setTimeout(3000, () => { req.destroy(); cb(null, null); });
  req.write('{}');
  req.end();
}

function loadSnapshot() {
  try { return JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8')); }
  catch { return { accounts: {} }; }
}

function saveSnapshot(data) {
  const tmp = SNAPSHOT_FILE + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, SNAPSHOT_FILE);
  } catch { /* best-effort */ }
}

function classifyPool(label = '') {
  const l = label.toLowerCase();
  if (['autocomplete','lite','embedding','tab'].some(k => l.includes(k))) return null;
  if (l.includes('flash'))  return 'gemini_flash';
  if (l.includes('gemini')) return 'gemini_pro';
  if (['claude','sonnet','opus','gpt'].some(k => l.includes(k))) return 'claude_gpt';
  return null;
}

function computePoolStatus(pct, resetIso) {
  if (pct >= 70) return 'ok';
  if (pct >= 15) return 'warning';
  if (resetIso && new Date(resetIso) <= new Date()) return 'replenished';
  return 'critical';
}

function countdown(resetIso) {
  if (!resetIso) return null;
  const diff = Math.max(0, new Date(resetIso) - Date.now());
  if (diff === 0) return '✅ Đã hồi đầy';
  const totalMin = Math.floor(diff / 60_000);
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  if (d > 0) return `${d}d ${h}h ${String(m).padStart(2, '0')}m`;
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

function formatLocalTime(isoStr) {
  if (!isoStr) return null;
  const d = new Date(isoStr);
  if (isNaN(d)) return null;
  if (d <= new Date()) return null; // already replenished
  return d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
}

function extractLivePools(statusData, summaryData) {
  const user_status = (statusData || {}).userStatus || statusData || {};
  const email = user_status.email || user_status.name;
  if (!email) return null;

  const plan = user_status.userTier?.name || 'Pro';
  const pools = {};

  // From RetrieveUserQuotaSummary groups
  const groups = summaryData?.response?.groups || summaryData?.groups || [];
  for (const grp of groups) {
    const grpName = String(grp.displayName || '').toLowerCase();
    for (const bkt of grp.buckets || []) {
      const bktId  = String(bkt.bucketId || '').toLowerCase();
      const window = String(bkt.window   || '').toLowerCase();
      const frac   = bkt.remainingFraction;
      const reset  = bkt.resetTime;

      let key;
      if (grpName.includes('claude') || bktId.includes('3p')) {
        key = (window.includes('5h') || bktId.includes('5h')) ? 'claude_5h' : 'claude_weekly';
      } else if (grpName.includes('argon') || bktId.includes('argon')) {
        key = 'argon_weekly';
      } else if (grpName.includes('gemini')) {
        key = (window.includes('5h') || bktId.includes('5h')) ? 'gemini_5h' : 'gemini_weekly';
      } else {
        key = bktId || grpName;
      }

      if (frac != null) {
        pools[key] = {
          remaining_fraction: Math.max(0, Math.min(1, parseFloat(frac))),
          reset_time:   reset || null,
          display_name: bkt.displayName || grp.displayName,
          window:       window || (key.includes('5h') ? '5h' : 'weekly'),
        };
      }
    }
  }

  return { email, plan, pools, last_seen_utc: new Date().toISOString() };
}

function buildApiResponse(snapshot, activeEmail) {
  const accounts = Object.values(snapshot.accounts || {}).map(acc => {
    const pools = {};
    for (const [key, pool] of Object.entries(acc.pools || {})) {
      const frac  = pool.remaining_fraction;
      const reset = pool.reset_time;
      const now   = new Date();
      const pct   = (reset && new Date(reset) <= now) ? 100 : Math.round(frac * 100);
      pools[key] = {
        pct,
        status:      computePoolStatus(pct, reset),
        reset_local: formatLocalTime(reset),
        countdown:   pct >= 100 ? '✅ Đã hồi đầy' : countdown(reset),
        display_name: pool.display_name || key,
        window:       pool.window || (key.includes('5h') ? '5h' : 'weekly'),
      };
    }

    // Status label: account is "ready" only if BOTH 5h AND weekly are healthy
    const isActive = acc.email === activeEmail;
    const fiveHourPcts = ['gemini_5h','gemini_flash','claude_5h','claude_gpt']
      .map(k => pools[k]?.pct).filter(v => v != null);
    const weeklyPcts = ['gemini_weekly','claude_weekly']
      .map(k => pools[k]?.pct).filter(v => v != null);
    const min5h = fiveHourPcts.length ? Math.min(...fiveHourPcts) : null;
    const minWk = weeklyPcts.length  ? Math.min(...weeklyPcts)  : null;
    let statusLabel;
    if (isActive) statusLabel = 'active';
    else if (min5h === null && minWk === null) statusLabel = 'unknown';
    else if ((min5h ?? 100) >= 50 && (minWk ?? 100) >= 10) statusLabel = 'ready';
    else if ((min5h ?? 0) > 5) statusLabel = 'low';
    else statusLabel = 'exhausted';

    return {
      email:        acc.email,
      plan:         acc.plan || 'Pro',
      is_active:    isActive,
      last_seen_utc: acc.last_seen_utc,
      status:       statusLabel,
      pools,
    };
  });

  // Sort: active first, then ready, then low, then exhausted
  const order = { active: 0, ready: 1, low: 2, unknown: 3, exhausted: 4 };
  accounts.sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9));

  const recommendations = accounts
    .filter(a => a.status === 'ready' && !a.is_active)
    .map(a => a.email);

  return {
    updated_at:          new Date().toISOString(),
    active_email:        activeEmail,
    accounts,
    switch_recommendations: recommendations,
  };
}

// ── Live data refresh ───────────────────────────────────────────────────────

function refreshLiveData(cb) {
  rpcPost('GetUserStatus', (_, statusData) => {
    rpcPost('RetrieveUserQuotaSummary', (_, summaryData) => {
      if (!statusData && !summaryData) return cb(null);
      const live = extractLivePools(statusData, summaryData);
      if (!live) return cb(null);

      const snapshot = loadSnapshot();
      snapshot.accounts = snapshot.accounts || {};
      snapshot.accounts[live.email] = { ...live };
      saveSnapshot(snapshot);
      cb(live.email);
    });
  });
}

const { URL } = require('url');

// ── Static file serving ─────────────────────────────────────────────────────

function serveStatic(res, filename) {
  const filepath = path.join(STATIC_DIR, filename);
  const ext      = path.extname(filename);
  try {
    let content = fs.readFileSync(filepath);
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    // Cache-bust static assets inside HTML
    if (filename === 'index.html') {
      const ts = Date.now();
      let html = content.toString('utf8');
      html = html.replace('/styles.css', `/styles.css?t=${ts}`);
      html = html.replace('/app.js', `/app.js?t=${ts}`);
      content = Buffer.from(html, 'utf8');
    }

    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}

// ── HTTP Server ─────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  console.log(`[quota-ui] ${req.method} ${req.url} headers:${JSON.stringify(req.headers['host']||'')}`);
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Parse pathname, stripping query string (app appends ?token=...&conversationId=...)
  const parsedUrl = new URL(req.url, 'http://localhost');
  const pathname  = parsedUrl.pathname;

  if (req.method === 'GET' && pathname === '/api/quota') {
    refreshLiveData((activeEmail) => {
      const snapshot = loadSnapshot();
      const payload  = buildApiResponse(snapshot, activeEmail);
      const body     = JSON.stringify(payload);
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(body);
    });
    return;
  }

  if (req.method === 'GET') {
    const filename = (pathname === '/' || pathname === '') ? 'index.html' : pathname.replace(/^\//, '');
    serveStatic(res, filename);
    return;
  }

  res.writeHead(405);
  res.end();
});

// Bind to the port injected by Antigravity; fall back to a random free port.
function getPort(cb) {
  const injected = parseInt(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT || '0', 10);
  if (injected > 0) return cb(injected);
  const srv = net.createServer();
  srv.listen(0, '127.0.0.1', () => {
    const p = srv.address().port;
    srv.close(() => cb(p));
  });
}

getPort((port) => {
  server.listen(port, '127.0.0.1', () => {
    console.log(`[quota-ui] server listening on http://127.0.0.1:${port}`);
  });
});
