const NAV_ITEMS = [
  { href: '/index.html', label: 'Overview' },
  { href: '/social-desk.html', label: 'Social Content Desk' },
  { href: '/buying-desk.html', label: 'Buying Desk' },
  { href: '/explorer.html', label: 'Trend Explorer' },
  { href: '/history.html', label: 'Trend History' },
  { href: '/compare.html', label: 'Compare' },
  { href: '/admin.html', label: 'Admin' }
];

// No login gate -- open to anyone with the URL. See src/lib/auth.js for
// why req.user still exists (audit-log attribution only, not access
// control).
async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(text || `Request failed: ${res.status}`);
  }
  const ct = res.headers.get('content-type') || '';
  return ct.includes('application/json') ? res.json() : res.text();
}

function renderNav(activeHref) {
  const nav = document.createElement('div');
  nav.className = 'nav';
  const brand = document.createElement('div');
  brand.className = 'brand';
  brand.innerHTML = 'Sportsgirl <span>Beauty Radar</span>';
  nav.appendChild(brand);
  for (const item of NAV_ITEMS) {
    const a = document.createElement('a');
    a.href = item.href;
    a.textContent = item.label;
    if (item.href === activeHref) a.className = 'active';
    nav.appendChild(a);
  }
  const spacer = document.createElement('div');
  spacer.className = 'spacer';
  nav.appendChild(spacer);
  document.body.prepend(nav);
}

async function initPage(activeHref) {
  renderNav(activeHref);
  try {
    return await api('/api/me');
  } catch {
    return { email: null, role: 'admin' };
  }
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtNum(n) {
  if (n === null || n === undefined) return '—';
  const num = Number(n);
  if (Math.abs(num) >= 1e6) return (num / 1e6).toFixed(1) + 'M';
  if (Math.abs(num) >= 1e3) return (num / 1e3).toFixed(1) + 'K';
  return String(Math.round(num));
}

function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
}

const STAGE_LABELS = {
  new_signal: 'New signal', emerging: 'Emerging', accelerating: 'Accelerating', peaking: 'Peaking',
  sustained: 'Sustained', cooling: 'Cooling', recurring_seasonal: 'Recurring / seasonal'
};
const DURABILITY_LABELS = { flash: 'Flash', early: 'Early', validated: 'Validated', sustained: 'Sustained', established: 'Established / seasonal' };
const FIT_LABELS = { core: 'Core fit', adjacent: 'Adjacent fit', content_only: 'Content-only fit', out_of_scope: 'Out of scope' };
const AU_LABELS = { confirmed: 'AU confirmed', emerging: 'AU emerging', absent: 'AU absent', unavailable: 'AU unknown' };

function stageBadge(stage) {
  return `<span class="badge stage-${esc(stage)}">${esc(STAGE_LABELS[stage] || stage || 'Unknown')}</span>`;
}
function fitBadge(fit) {
  return `<span class="badge fit-${esc(fit)}">${esc(FIT_LABELS[fit] || fit)}</span>`;
}
function auBadge(state) {
  return `<span class="badge au-${esc(state)}">${esc(AU_LABELS[state] || state)}</span>`;
}
function durabilityBadge(label) {
  return `<span class="badge neutral">${esc(DURABILITY_LABELS[label] || label)}</span>`;
}

function scoreLine(t) {
  return `<div class="scores">
    <span class="score-pill score-social">Social <span class="num">${t.socialScore ?? '—'}</span></span>
    <span class="score-pill score-buying">Buying <span class="num">${t.buyingScore ?? '—'}</span></span>
    <span class="score-pill score-confidence">Confidence <span class="num">${t.confidenceScore ?? '—'}</span>${t.isProvisional ? ' <em>(provisional)</em>' : ''}</span>
  </div>`;
}

function platformEvidenceLine(platforms) {
  if (!platforms || platforms.length === 0) return 'No platform evidence yet.';
  return platforms.map((p) => {
    if (p.platform === 'reddit') return `Reddit: ${p.cumulative_posts} posts, ${fmtNum(p.comments_sum)} comments`;
    return `${p.platform[0].toUpperCase()}${p.platform.slice(1)}: ${fmtNum(p.plays_sum)} plays (${p.plays_new > 0 ? '+' + fmtNum(p.plays_new) : 'flat'} today), ${p.cumulative_posts} posts`;
  }).join(' · ');
}

function trendCardHtml(t) {
  return `<a href="/trend.html?id=${t.id}" class="card trend-card" style="display:block;color:inherit;">
    <div class="top-row">
      <div>
        <div class="name">${esc(t.name)}</div>
        <div class="def">${esc(t.definition || '')}</div>
      </div>
      ${stageBadge(t.lifecycleStage)}
    </div>
    <div class="meta-row">
      ${fitBadge(t.brandFit)} ${auBadge(t.marketAuState)} ${durabilityBadge(t.durabilityLabel)}
      <span>Age ${t.trendAgeDays ?? '—'}d · ${t.consecutiveActiveDays ?? 0}d consecutive</span>
    </div>
    ${scoreLine(t)}
    <div class="evidence-line">${platformEvidenceLine(t.platforms)}</div>
    ${t.recommendedActionLabel ? `<div class="action">→ ${esc(t.recommendedActionLabel)}</div>` : ''}
  </a>`;
}

// Minimal inline SVG line chart -- no external charting dependency.
function sparklineSvg(points, { width = 600, height = 140, color = '#c22557', label = '' } = {}) {
  if (!points || points.length === 0) return `<div class="empty">No data yet.</div>`;
  const vals = points.map((p) => p.value);
  const min = Math.min(...vals, 0), max = Math.max(...vals, 1);
  const range = max - min || 1;
  const stepX = width / Math.max(1, points.length - 1);
  const path = points.map((p, i) => {
    const x = i * stepX;
    const y = height - ((p.value - min) / range) * (height - 20) - 10;
    return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  return `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" preserveAspectRatio="none">
    <path d="${path}" fill="none" stroke="${color}" stroke-width="2" vector-effect="non-scaling-stroke"/>
  </svg>`;
}
