const CATEGORY_META = {
  parking:             { label: 'Parking',               bg: '#eaf3ff', fg: '#145bbb', bar: '#1467e8' },
  pickup_dropoff:      { label: 'Pick-up & drop-off',     bg: '#fff1e5', fg: '#995412', bar: '#e2924c' },
  taxi_rideshare:      { label: 'Taxi & rideshare',       bg: '#f0ecff', fg: '#6145c3', bar: '#7257d5' },
  public_transport:    { label: 'Public transport',       bg: '#e6f7f5', fg: '#0f7d72', bar: '#50a8a1' },
  terminal_experience: { label: 'Terminal experience',    bg: '#fdeef0', fg: '#a3355a', bar: '#c4547a' },
  general_airport:     { label: 'General airport',        bg: '#edf7ef', fg: '#39734a', bar: '#55a86d' },
  unclassified:        { label: 'Unclassified',           bg: '#eef1f5', fg: '#556174', bar: '#b7c0ce' }
};
const SENTIMENT_META = {
  positive:     { label: 'Positive',     bg: '#e9f8ef', fg: '#187544' },
  neutral:      { label: 'Neutral',      bg: '#eef1f5', fg: '#556174' },
  negative:     { label: 'Negative',     bg: '#ffeded', fg: '#ad2f2f' },
  unclassified: { label: 'Unclassified', bg: '#eef1f5', fg: '#556174' }
};
const SOURCE_LABELS = {
  reddit: 'Reddit', youtube: 'YouTube', facebook_search: 'Facebook (search)',
  instagram_search: 'Instagram (search)', linkedin_search: 'LinkedIn (search)', web_search: 'Web',
  news_search: 'News', facebook_direct: 'Facebook (direct)', instagram_direct: 'Instagram (hashtag)',
  google_reviews: 'Google reviews', facebook_own: 'Facebook (MelAir)', instagram_own: 'Instagram (MelAir)'
};
const SOURCE_PALETTE = ['#1467e8', '#7257d5', '#e2924c', '#50a8a1', '#c4547a', '#55a86d', '#a96408', '#6145c3', '#0d9488', '#dc2626', '#0891b2', '#c026d3'];
function sourceLabel(s) { return SOURCE_LABELS[s] || s; }
function sourceColor(s) {
  const keys = Object.keys(SOURCE_LABELS);
  const idx = keys.indexOf(s);
  return SOURCE_PALETTE[idx >= 0 ? idx % SOURCE_PALETTE.length : Math.abs(hashCode(s)) % SOURCE_PALETTE.length];
}
function hashCode(str) { let h = 0; for (let i = 0; i < str.length; i++) h = (h << 5) - h + str.charCodeAt(i); return h; }

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const state = {
  view: 'overview',
  filters: { q: '', category: 'all', sentiment: 'all', source: 'all', days: 14 },
  page: 1,
  pageSize: 20,
  density: 'comfortable',
  trendMode: 'volume',
  analytics: null,
  mentionsResp: null
};

function readStateFromUrl() {
  const p = new URLSearchParams(location.search);
  state.view = p.get('view') || 'overview';
  state.filters.q = p.get('q') || '';
  state.filters.category = p.get('category') || 'all';
  state.filters.sentiment = p.get('sentiment') || 'all';
  state.filters.source = p.get('source') || 'all';
  state.filters.days = Number(p.get('days')) || 14;
  state.page = Number(p.get('page')) || 1;
  state.density = p.get('density') || 'comfortable';
}

function writeStateToUrl() {
  const p = new URLSearchParams();
  if (state.view !== 'overview') p.set('view', state.view);
  if (state.filters.q) p.set('q', state.filters.q);
  if (state.filters.category !== 'all') p.set('category', state.filters.category);
  if (state.filters.sentiment !== 'all') p.set('sentiment', state.filters.sentiment);
  if (state.filters.source !== 'all') p.set('source', state.filters.source);
  if (state.filters.days !== 14) p.set('days', state.filters.days);
  if (state.page !== 1) p.set('page', state.page);
  if (state.density !== 'comfortable') p.set('density', state.density);
  const qs = p.toString();
  history.replaceState(null, '', qs ? `?${qs}` : location.pathname);
}

function syncControlsFromState() {
  document.getElementById('search').value = state.filters.q;
  document.getElementById('category').value = state.filters.category;
  document.getElementById('sentiment').value = state.filters.sentiment;
  document.getElementById('source').value = state.filters.source;
  document.getElementById('period').value = String(state.filters.days);
  document.querySelectorAll('#mainNav a').forEach((a) => a.classList.toggle('active', a.dataset.view === state.view));
  document.querySelectorAll('.viewtoggle button[data-density]').forEach((b) => b.classList.toggle('on', b.dataset.density === state.density));
  const table = document.querySelector('#mentionsSection .tablewrap table');
  if (table) table.parentElement.parentElement.classList.toggle('density-compact', state.density === 'compact');
}

function apiQueryString(extra) {
  const p = new URLSearchParams();
  if (state.filters.q) p.set('q', state.filters.q);
  if (state.filters.category !== 'all') p.set('category', state.filters.category);
  if (state.filters.sentiment !== 'all') p.set('sentiment', state.filters.sentiment);
  if (state.filters.source !== 'all') p.set('source', state.filters.source);
  p.set('days', state.filters.days);
  Object.entries(extra || {}).forEach(([k, v]) => p.set(k, v));
  return p.toString();
}

async function loadAll() {
  setLoading(true);
  try {
    const [analyticsRes, mentionsRes] = await Promise.all([
      fetch(`/api/analytics?${apiQueryString()}`).then((r) => r.json()),
      fetch(`/api/mentions?${apiQueryString({ page: state.page, pageSize: state.pageSize })}`).then((r) => r.json())
    ]);
    state.analytics = analyticsRes;
    state.mentionsResp = mentionsRes;
    render();
    document.getElementById('syncStatus').textContent = `Updated ${new Date().toLocaleTimeString('en-AU', { timeZone: 'Australia/Melbourne', hour: 'numeric', minute: '2-digit' })}`;
  } catch (err) {
    document.getElementById('syncStatus').textContent = 'Update failed';
    console.error(err);
  } finally {
    setLoading(false);
  }
}

function setLoading(isLoading) {
  document.querySelectorAll('.kpi .value').forEach((el) => { if (isLoading) el.classList.add('skel'); else el.classList.remove('skel'); });
}

function render() {
  const steps = [
    writeStateToUrl,
    syncControlsFromState,
    renderActiveFilterChips,
    applyViewVisibility,
    renderSourceOptions,
    renderKpis,
    renderChart,
    renderCategoryBars,
    renderCategoryDetail,
    renderSourceBars,
    renderWatchNote,
    renderMentions
  ];
  for (const step of steps) {
    try {
      step();
    } catch (err) {
      console.error(`render step "${step.name}" failed:`, err);
    }
  }
}

function applyViewVisibility() {
  const v = state.view;
  document.getElementById('kpis').hidden = v === 'mentions' || v === 'categories' || v === 'sources' || v === 'settings';
  document.getElementById('overviewGrid').hidden = v !== 'overview';
  document.getElementById('mentionsSection').hidden = v === 'categories' || v === 'sources' || v === 'settings';
  document.getElementById('categoriesSection').hidden = v !== 'categories';
  document.getElementById('sourcesSection').hidden = v !== 'sources';
  document.getElementById('settingsSection').hidden = v !== 'settings';
  document.getElementById('mentionsTitle').textContent = v === 'mentions' ? 'All mentions' : 'Recent mentions';
  document.getElementById('reclassifyBtn').hidden = state.filters.category !== 'unclassified';
}

function renderActiveFilterChips() {
  const chips = [];
  const f = state.filters;
  if (f.category !== 'all') chips.push(['category', `Category: ${CATEGORY_META[f.category]?.label || f.category}`]);
  if (f.sentiment !== 'all') chips.push(['sentiment', `Sentiment: ${SENTIMENT_META[f.sentiment]?.label || f.sentiment}`]);
  if (f.source !== 'all') chips.push(['source', `Source: ${sourceLabel(f.source)}`]);
  if (f.q) chips.push(['q', `"${f.q}"`]);
  const container = document.getElementById('activeFilter');
  container.classList.toggle('show', chips.length > 0);
  container.innerHTML = chips.length
    ? '<span>Showing:</span>' + chips.map(([key, label]) =>
        `<span class="chip">${escapeHtml(label)}<button type="button" data-remove-filter="${key}" aria-label="Remove filter">×</button></span>`
      ).join('')
    : '';
}

function renderSourceOptions() {
  const sel = document.getElementById('source');
  if (sel.dataset.populated) return;
  const known = Object.keys(SOURCE_LABELS);
  sel.innerHTML = '<option value="all">All sources</option>' + known.map((s) => `<option value="${s}">${sourceLabel(s)}</option>`).join('');
  sel.value = state.filters.source;
  sel.dataset.populated = '1';
}

function fmtPct(p) { return `${p}%`; }
function fmtDelta(pct, invert) {
  if (pct === null || pct === undefined) return '';
  const up = invert ? pct < 0 : pct > 0;
  const cls = pct === 0 ? '' : up ? 'up' : 'down';
  const arrow = pct > 0 ? '↑' : pct < 0 ? '↓' : '→';
  return `<span class="${cls}">${arrow} ${Math.abs(pct)}%</span> vs previous period`;
}

function renderKpis() {
  const a = state.analytics;
  if (!a) return;
  document.getElementById('kpiTotal').textContent = a.total.toLocaleString();
  document.getElementById('kpiTotalDelta').innerHTML = fmtDelta(a.previousPeriod.totalChangePct);

  document.getElementById('kpiPositive').textContent = fmtPct(a.sentiment.positive.pct);
  document.getElementById('kpiPositiveDelta').textContent = `${a.sentiment.positive.count.toLocaleString()} mentions`;

  document.getElementById('kpiNegative').textContent = fmtPct(a.sentiment.negative.pct);
  const negPtDelta = a.previousPeriod.sentiment.negative.pct - a.sentiment.negative.pct;
  document.getElementById('kpiNegativeDelta').innerHTML = a.previousPeriod.total > 0
    ? fmtDelta(Math.round(-negPtDelta * 10) / 10, true).replace('vs previous period', 'pts vs previous period')
    : '';

  const realCats = a.categories.filter((c) => c.category !== 'unclassified');
  const largest = realCats.reduce((max, c) => (c.count > (max?.count || 0) ? c : max), null);
  document.getElementById('kpiLargest').textContent = largest ? largest.label : '–';
  document.getElementById('kpiLargestDelta').textContent = largest && a.total > 0
    ? `${Math.round((largest.count / a.total) * 1000) / 10}% of all mentions` : '';

  const unclassified = a.categories.find((c) => c.category === 'unclassified');
  const uCount = unclassified ? unclassified.count : 0;
  document.getElementById('kpiUnclassified').textContent = uCount.toLocaleString();
  document.getElementById('kpiUnclassifiedDelta').textContent = a.total > 0 ? `${Math.round((uCount / a.total) * 1000) / 10}% of mentions` : '';
  document.getElementById('reviewCount').textContent = uCount;
}

let trendChart;
function renderChart() {
  const a = state.analytics;
  if (!a) return;
  const canvas = document.getElementById('trendChart');
  if (!canvas) return;
  if (typeof Chart === 'undefined') {
    canvas.closest('.chart-wrap').innerHTML = '<p class="chart-unavailable">Chart could not load.</p>';
    return;
  }
  const ctx = canvas.getContext('2d');
  const labels = a.timeSeries.map((d) => new Date(d.day + 'T00:00:00').toLocaleDateString('en-AU', { day: 'numeric', month: 'short' }));

  let datasets;
  if (state.trendMode === 'volume') {
    datasets = [
      { label: 'Total mentions', data: a.timeSeries.map((d) => d.total), borderColor: '#1467e8', backgroundColor: 'rgba(20,103,232,.15)', fill: true, tension: 0.3 },
      { label: 'Negative', data: a.timeSeries.map((d) => d.negative), borderColor: '#c43d3d', borderDash: [5, 5], fill: false, tension: 0.3 }
    ];
  } else {
    datasets = [
      { label: 'Positive', data: a.timeSeries.map((d) => d.positive), borderColor: '#14804a', fill: false, tension: 0.3 },
      { label: 'Neutral', data: a.timeSeries.map((d) => d.neutral), borderColor: '#68758a', fill: false, tension: 0.3 },
      { label: 'Negative', data: a.timeSeries.map((d) => d.negative), borderColor: '#c43d3d', fill: false, tension: 0.3 }
    ];
  }

  if (trendChart) trendChart.destroy();
  trendChart = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: { y: { beginAtZero: true, ticks: { precision: 0 } } },
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 11 } } },
        tooltip: {
          callbacks: {
            afterTitle: (items) => (a.timeSeries[items[0].dataIndex]?.partial ? '(partial day)' : '')
          }
        }
      }
    }
  });
}

function renderCategoryBars() {
  const a = state.analytics;
  if (!a) return;
  const sorted = [...a.categories].sort((x, y) => y.count - x.count);
  const max = sorted.length ? sorted[0].count : 0;
  const container = document.getElementById('categoryBars');
  container.innerHTML = sorted.map((c) => {
    const meta = CATEGORY_META[c.category] || CATEGORY_META.unclassified;
    const width = max > 0 ? Math.max((c.count / max) * 100, c.count > 0 ? 3 : 0) : 0;
    const active = state.filters.category === c.category;
    return `<button class="catrow${active ? ' active' : ''}" type="button" data-category="${c.category}">
      <strong>${escapeHtml(meta.label)}</strong>
      <span class="bar"><i style="width:${width}%;background:${meta.bar}"></i></span>
      <span>${c.count.toLocaleString()}</span>
    </button>`;
  }).join('');
}

// Dedicated Categories view: one row per category with its count, share of
// the filtered total, sentiment split, and change vs. the immediately
// preceding equivalent period -- all derived directly from a.categories /
// a.previousPeriod.categories, never invented client-side.
function renderCategoryDetail() {
  const a = state.analytics;
  const container = document.getElementById('categoryDetail');
  if (!a) return;
  const sorted = [...a.categories].sort((x, y) => y.count - x.count);
  const prevByCategory = new Map(a.previousPeriod.categories.map((c) => [c.category, c.count]));

  const legend = ['positive', 'neutral', 'negative', 'unclassified'].map((s) =>
    `<span><i style="background:${sentimentBarColor(s)}"></i>${SENTIMENT_META[s].label}</span>`
  ).join('');

  const rows = sorted.map((c) => {
    const meta = CATEGORY_META[c.category] || CATEGORY_META.unclassified;
    const share = a.total > 0 ? Math.round((c.count / a.total) * 1000) / 10 : 0;
    const s = c.sentiment;
    const segTotal = s.positive + s.neutral + s.negative + s.unclassified || 1;
    const seg = (n) => (n / segTotal) * 100;
    const prevCount = prevByCategory.get(c.category) || 0;
    let trend;
    if (prevCount === 0 && c.count === 0) trend = { text: '– no data', cls: '' };
    else if (prevCount === 0) trend = { text: 'New this period', cls: 'up' };
    else {
      const changePct = Math.round(((c.count - prevCount) / prevCount) * 1000) / 10;
      trend = changePct === 0
        ? { text: 'Flat vs. last period', cls: '' }
        : { text: `${Math.abs(changePct)}% vs. last period`, cls: changePct > 0 ? 'up' : 'down' };
    }
    const active = state.filters.category === c.category;
    return `<button class="catdetailrow" type="button" data-category="${c.category}" style="${active ? 'background:#f8fafc' : ''}">
      <div>
        <div class="catdetail-name">${escapeHtml(meta.label)}</div>
        <div class="catdetail-share">${share}% of filtered mentions</div>
      </div>
      <div>
        <div class="catdetail-stack">
          <span style="width:${seg(s.positive)}%;background:${sentimentBarColor('positive')}"></span>
          <span style="width:${seg(s.neutral)}%;background:${sentimentBarColor('neutral')}"></span>
          <span style="width:${seg(s.negative)}%;background:${sentimentBarColor('negative')}"></span>
          <span style="width:${seg(s.unclassified)}%;background:${sentimentBarColor('unclassified')}"></span>
        </div>
      </div>
      <div class="catdetail-count">${c.count.toLocaleString()}</div>
      <div class="catdetail-trend ${trend.cls}">${trend.text}</div>
    </button>`;
  }).join('');

  container.innerHTML = `<div class="catdetail-legend-row">${legend}</div>${rows || '<p style="color:var(--muted);font-size:13px;padding:14px 0;">No data for this period.</p>'}`;
}

function sentimentBarColor(s) {
  return { positive: '#14804a', neutral: '#c9d2df', negative: '#c43d3d', unclassified: '#dfe5ee' }[s];
}

function renderSourceBars() {
  const a = state.analytics;
  if (!a) return;
  const sorted = [...a.bySource].sort((x, y) => y.count - x.count);
  const max = sorted.length ? sorted[0].count : 0;
  document.getElementById('sourceBars').innerHTML = sorted.map((s) => {
    const width = max > 0 ? Math.max((s.count / max) * 100, 3) : 0;
    return `<div class="catrow" style="grid-template-columns:minmax(150px,1.35fr) 2.4fr 50px;cursor:default;">
      <strong>${escapeHtml(sourceLabel(s.source))}</strong>
      <span class="bar"><i style="width:${width}%;background:${sourceColor(s.source)}"></i></span>
      <span>${s.count.toLocaleString()}</span>
    </div>`;
  }).join('') || '<p style="color:var(--muted);font-size:13px;">No data for this period.</p>';
}

// One generated insight, only when the swing is both a meaningful share of
// volume and not just noise from a tiny sample -- never invented, always
// derived directly from the returned negativeByCategory aggregates.
function renderWatchNote() {
  const a = state.analytics;
  const note = document.getElementById('watchNote');
  if (!a || a.previousPeriod.total === 0) { note.hidden = true; return; }

  let best = null;
  for (const cur of a.negativeByCategory) {
    if (cur.category === 'unclassified' || cur.count < 5) continue;
    const prev = a.previousPeriod.negativeByCategory.find((p) => p.category === cur.category);
    if (!prev || prev.count < 3) continue;
    const changePct = Math.round(((cur.count - prev.count) / prev.count) * 100);
    if (Math.abs(changePct) >= 15 && (!best || Math.abs(changePct) > Math.abs(best.changePct))) {
      best = { label: cur.label, changePct };
    }
  }

  if (!best) { note.hidden = true; return; }
  const dir = best.changePct > 0 ? 'up' : 'down';
  note.hidden = false;
  note.innerHTML = `<strong>Watch:</strong> Negative ${escapeHtml(best.label.toLowerCase())} mentions are ${dir} ${Math.abs(best.changePct)}% versus the previous ${state.filters.days} days.`;
}

function renderMentions() {
  const resp = state.mentionsResp;
  if (!resp) return;
  const rows = resp.results;
  document.getElementById('mentionsEmpty').hidden = rows.length > 0;
  document.querySelector('#mentionsSection .tablewrap').hidden = rows.length === 0;

  const rowHtml = (m) => {
    const catMeta = CATEGORY_META[m.category] || CATEGORY_META.unclassified;
    const sentMeta = SENTIMENT_META[m.sentiment || 'unclassified'] || SENTIMENT_META.unclassified;
    const when = new Date(m.first_seen_at).toLocaleString('en-AU', { timeZone: 'Australia/Melbourne', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
    const titleHtml = m.title ? `<div class="mention-title">${escapeHtml(m.title)}</div>` : '';
    const snippetHtml = m.snippet ? `<div class="snippet">${escapeHtml(m.snippet)}</div>` : '';
    const confidence = typeof m.category_confidence === 'number' ? `${Math.round(m.category_confidence * 100)}%` : '—';
    const openLink = m.url ? `<a href="${m.url}" target="_blank" rel="noopener">Open ↗</a>` : '';
    return { catMeta, sentMeta, when, titleHtml, snippetHtml, confidence, openLink };
  };

  document.getElementById('mentionRows').innerHTML = rows.map((m) => {
    const r = rowHtml(m);
    return `<tr>
      <td><span class="source">${escapeHtml(sourceLabel(m.source))}</span><span class="sub">${r.when}</span></td>
      <td>
        <select class="catselect" data-manual-category="${m.id}" style="background:${r.catMeta.bg};color:${r.catMeta.fg}">
          ${Object.entries(CATEGORY_META).map(([val, meta]) => `<option value="${val}" ${val === m.category ? 'selected' : ''}>${escapeHtml(meta.label)}</option>`).join('')}
        </select>
      </td>
      <td><span class="pill" style="background:${r.sentMeta.bg};color:${r.sentMeta.fg}">${escapeHtml(r.sentMeta.label)}</span></td>
      <td>${r.titleHtml}${r.snippetHtml}</td>
      <td>${m.author ? escapeHtml(m.author) : '—'}</td>
      <td class="confidence">${r.confidence}</td>
      <td class="actions">${r.openLink}</td>
    </tr>`;
  }).join('');

  document.getElementById('mentionCards').innerHTML = rows.map((m) => {
    const r = rowHtml(m);
    return `<div class="card" style="padding:12px;margin-bottom:10px;">
      <div style="display:flex;justify-content:space-between;gap:8px;margin-bottom:6px;">
        <span class="source">${escapeHtml(sourceLabel(m.source))}</span>
        <span class="pill" style="background:${r.sentMeta.bg};color:${r.sentMeta.fg}">${escapeHtml(r.sentMeta.label)}</span>
      </div>
      <div class="sub" style="margin-bottom:6px;">${r.when}</div>
      ${r.titleHtml}${r.snippetHtml}
      <div style="display:flex;justify-content:space-between;align-items:center;margin-top:8px;">
        <span class="pill" style="background:${r.catMeta.bg};color:${r.catMeta.fg}">${escapeHtml(r.catMeta.label)}</span>
        ${r.openLink}
      </div>
    </div>`;
  }).join('');

  document.getElementById('visibleCount').textContent = `${resp.total.toLocaleString()} matching mentions`;
  renderPager(resp);
}

function renderPager(resp) {
  const totalPages = Math.max(1, Math.ceil(resp.total / resp.pageSize));
  const cur = resp.page;
  document.getElementById('pagerSummary').textContent = resp.total > 0
    ? `Showing ${(cur - 1) * resp.pageSize + 1}-${Math.min(cur * resp.pageSize, resp.total)} of ${resp.total}`
    : '';

  const pageNumbers = [];
  const start = Math.max(1, cur - 2);
  const end = Math.min(totalPages, start + 4);
  for (let i = start; i <= end; i++) pageNumbers.push(i);

  const pager = document.getElementById('pager');
  pager.innerHTML =
    `<button type="button" data-page="${cur - 1}" ${cur <= 1 ? 'disabled' : ''} aria-label="Previous page">‹</button>` +
    pageNumbers.map((n) => `<button type="button" class="${n === cur ? 'on' : ''}" data-page="${n}">${n}</button>`).join('') +
    `<button type="button" data-page="${cur + 1}" ${cur >= totalPages ? 'disabled' : ''} aria-label="Next page">›</button>`;
}

function getAdminToken() {
  let token = sessionStorage.getItem('adminToken');
  if (!token) {
    token = prompt('Admin token required for this action:');
    if (token) sessionStorage.setItem('adminToken', token);
  }
  return token;
}

async function setManualCategory(id, category) {
  const token = getAdminToken();
  if (!token) { loadAll(); return; }
  const res = await fetch(`/admin/mentions/${id}/category`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ category })
  });
  if (res.status === 403) {
    sessionStorage.removeItem('adminToken');
    alert('Admin token was rejected. Please try again.');
  } else if (!res.ok) {
    alert('Failed to update category.');
  }
  loadAll();
}

async function reclassifyUnclassified() {
  const token = getAdminToken();
  if (!token) return;
  const btn = document.getElementById('reclassifyBtn');
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Reclassifying…';
  try {
    const res = await fetch('/admin/reclassify-unclassified', { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 403) {
      sessionStorage.removeItem('adminToken');
      alert('Admin token was rejected. Please try again.');
    } else {
      const data = await res.json();
      alert(`Reclassified ${data.reclassified} of ${data.attempted} unclassified mentions.`);
    }
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
    loadAll();
  }
}

// Pages through /admin/backfill-categories until the server reports no rows
// left with no category at all -- capped at 50 pages (5,000 mentions) per
// click so one runaway backlog can't hang the button indefinitely; a second
// click resumes automatically since the server-side cursor is stateless
// (each call starts from afterId=0 and just stops once nothing matches).
async function backfillCategories() {
  const token = getAdminToken();
  if (!token) return;
  const btn = document.getElementById('backfillBtn');
  const originalText = btn.textContent;
  btn.disabled = true;
  let afterId = 0;
  let totalAttempted = 0;
  let totalBackfilled = 0;
  try {
    for (let page = 0; page < 50; page++) {
      btn.textContent = totalAttempted > 0 ? `Backfilling… (${totalAttempted} processed)` : 'Backfilling…';
      const res = await fetch('/admin/backfill-categories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ afterId })
      });
      if (res.status === 403) {
        sessionStorage.removeItem('adminToken');
        alert('Admin token was rejected. Please try again.');
        return;
      }
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert(`Backfill failed: ${err.error || res.status}`);
        return;
      }
      const data = await res.json();
      totalAttempted += data.attempted;
      totalBackfilled += data.backfilled;
      afterId = data.lastId;
      if (data.done) {
        alert(totalAttempted === 0
          ? 'Nothing to backfill -- every mention already has a category.'
          : `Backfill complete: classified ${totalBackfilled} of ${totalAttempted} mentions that had no category.`);
        return;
      }
    }
    alert(`Backfilled ${totalBackfilled} of ${totalAttempted} so far. There's more left -- click "Backfill missing categories" again to continue.`);
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
    loadAll();
  }
}

function exportCsv() {
  fetch(`/api/mentions?${apiQueryString({ page: 1, pageSize: 1000 })}`)
    .then((r) => r.json())
    .then((resp) => {
      const cols = ['source', 'category', 'sentiment', 'severity', 'category_confidence', 'title', 'snippet', 'author', 'first_seen_at', 'url'];
      const csvEscape = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const lines = [cols.join(',')].concat(resp.results.map((r) => cols.map((c) => csvEscape(r[c])).join(',')));
      const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `melbourne-airport-mentions-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    });
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function wireEvents() {
  document.getElementById('search').addEventListener('input', debounce((e) => {
    state.filters.q = e.target.value; state.page = 1; loadAll();
  }, 350));
  document.getElementById('category').addEventListener('change', (e) => { state.filters.category = e.target.value; state.page = 1; loadAll(); });
  document.getElementById('sentiment').addEventListener('change', (e) => { state.filters.sentiment = e.target.value; state.page = 1; loadAll(); });
  document.getElementById('source').addEventListener('change', (e) => { state.filters.source = e.target.value; state.page = 1; loadAll(); });
  document.getElementById('period').addEventListener('change', (e) => { state.filters.days = Number(e.target.value); state.page = 1; loadAll(); });
  document.getElementById('clearBtn').addEventListener('click', () => {
    state.filters = { q: '', category: 'all', sentiment: 'all', source: 'all', days: 14 };
    state.page = 1;
    loadAll();
  });

  document.getElementById('activeFilter').addEventListener('click', (e) => {
    const key = e.target.closest('[data-remove-filter]')?.dataset.removeFilter;
    if (!key) return;
    state.filters[key] = key === 'q' ? '' : 'all';
    state.page = 1;
    loadAll();
  });

  document.getElementById('mainNav').addEventListener('click', (e) => {
    const a = e.target.closest('a[data-view]');
    if (!a) return;
    e.preventDefault();
    state.view = a.dataset.view;
    render();
  });

  document.getElementById('reviewUnclassifiedBtn').addEventListener('click', () => {
    state.filters.category = 'unclassified';
    state.view = 'mentions';
    state.page = 1;
    loadAll();
  });

  document.getElementById('reclassifyBtn').addEventListener('click', reclassifyUnclassified);

  document.getElementById('backfillBtn').addEventListener('click', backfillCategories);

  document.getElementById('exportBtn').addEventListener('click', exportCsv);

  document.querySelectorAll('.seg button[data-trend]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.trendMode = btn.dataset.trend;
      document.querySelectorAll('.seg button[data-trend]').forEach((b) => b.classList.toggle('on', b === btn));
      renderChart();
    });
  });

  document.querySelectorAll('.viewtoggle button[data-density]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.density = btn.dataset.density;
      render();
    });
  });

  document.getElementById('categoryBars').addEventListener('click', (e) => {
    const row = e.target.closest('[data-category]');
    if (!row) return;
    const cat = row.dataset.category;
    state.filters.category = state.filters.category === cat ? 'all' : cat;
    state.page = 1;
    loadAll();
  });

  document.getElementById('categoryDetail').addEventListener('click', (e) => {
    const row = e.target.closest('[data-category]');
    if (!row) return;
    const cat = row.dataset.category;
    state.filters.category = state.filters.category === cat ? 'all' : cat;
    state.view = 'mentions';
    state.page = 1;
    loadAll();
  });

  document.getElementById('mentionRows').addEventListener('change', (e) => {
    const sel = e.target.closest('[data-manual-category]');
    if (!sel) return;
    setManualCategory(Number(sel.dataset.manualCategory), sel.value);
  });

  document.getElementById('pager').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-page]');
    if (!btn || btn.disabled) return;
    state.page = Number(btn.dataset.page);
    loadAll();
  });
}

readStateFromUrl();
wireEvents();
loadAll();
