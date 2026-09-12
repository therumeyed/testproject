require('dotenv').config();
const express = require('express');
const path = require('path');
const { pool, initSchemaWithRetry, setManualCategory, getUnclassifiedMentions, getMentionsNeedingCategoryBackfill, updateCategory } = require('./db');
const { classifyMentions } = require('./sentiment');
const { CATEGORIES, CATEGORY_VALUES } = require('./categories');
const { parseFilters, buildWhere, previousPeriod } = require('./filters');

const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));

function requireAdmin(req, res, next) {
  const token = req.get('Authorization')?.replace(/^Bearer\s+/i, '');
  if (!process.env.ADMIN_TOKEN || token !== process.env.ADMIN_TOKEN) {
    return res.status(403).json({ error: 'forbidden' });
  }
  next();
}

function melbourneDateString(date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Melbourne' }).format(date);
}

// Melbourne-calendar-day range covering [from, to], inclusive, as YYYY-MM-DD
// strings -- used to zero-fill days with no mentions in the trend chart.
function buildDayRange(from, to) {
  const days = [];
  const endStr = melbourneDateString(to);
  const cursor = new Date(from);
  let cursorStr = melbourneDateString(cursor);
  // Guard against runaway loops (e.g. a malformed date range) -- a bounded
  // reporting window has no legitimate reason to span this many days.
  let guard = 0;
  while (cursorStr <= endStr && guard < 3660) {
    days.push(cursorStr);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    cursorStr = melbourneDateString(cursor);
    guard++;
  }
  return days;
}

app.get('/health', (req, res) => res.json({ ok: true }));

app.get('/api/mentions', async (req, res) => {
  const filters = parseFilters(req.query);
  const { where, params } = buildWhere(filters, filters.from, filters.to);

  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(Math.max(Number(req.query.pageSize) || 20, 1), 200);
  const offset = (page - 1) * pageSize;

  const countRes = await pool.query(`SELECT count(*)::int AS total FROM mentions WHERE ${where}`, params);
  const dataParams = [...params, pageSize, offset];
  const dataRes = await pool.query(
    `SELECT id, source, url, title, snippet, author, posted_at, first_seen_at,
            sentiment, severity, sentiment_reason,
            COALESCE(category, 'unclassified') AS category, category_confidence, category_source
     FROM mentions WHERE ${where}
     ORDER BY first_seen_at DESC
     LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length}`,
    dataParams
  );
  res.json({ total: countRes.rows[0].total, page, pageSize, results: dataRes.rows });
});

// Powers every KPI card, the trend chart, and the category bars from one
// consistent, server-side-filtered dataset -- never derived by filtering
// only the visible page of table results.
app.get('/api/analytics', async (req, res) => {
  const filters = parseFilters(req.query);
  const { where, params } = buildWhere(filters, filters.from, filters.to);
  const prev = previousPeriod(filters.from, filters.to);
  const { where: prevWhere, params: prevParams } = buildWhere(filters, prev.from, prev.to);

  const [totalRes, categoryRes, categorySentimentRes, sourceRes, dayRes, categoryNegRes, prevTotalRes, prevSentimentRes, prevCategoryRes, prevCategoryNegRes] = await Promise.all([
    pool.query(`SELECT count(*)::int AS total FROM mentions WHERE ${where}`, params),
    pool.query(
      `SELECT COALESCE(category, 'unclassified') AS category, count(*)::int AS count
       FROM mentions WHERE ${where} GROUP BY 1`,
      params
    ),
    pool.query(
      `SELECT COALESCE(category, 'unclassified') AS category,
              COALESCE(sentiment, 'unclassified') AS sentiment, count(*)::int AS count
       FROM mentions WHERE ${where} GROUP BY 1, 2`,
      params
    ),
    pool.query(
      `SELECT source, count(*)::int AS count FROM mentions WHERE ${where} GROUP BY 1 ORDER BY 2 DESC`,
      params
    ),
    pool.query(
      `SELECT (first_seen_at AT TIME ZONE 'Australia/Melbourne')::date AS day,
              COALESCE(sentiment, 'unclassified') AS sentiment, count(*)::int AS count
       FROM mentions WHERE ${where} GROUP BY 1, 2 ORDER BY 1 ASC`,
      params
    ),
    pool.query(
      `SELECT COALESCE(category, 'unclassified') AS category, count(*)::int AS count
       FROM mentions WHERE ${where} AND sentiment = 'negative' GROUP BY 1`,
      params
    ),
    pool.query(`SELECT count(*)::int AS total FROM mentions WHERE ${prevWhere}`, prevParams),
    pool.query(
      `SELECT COALESCE(sentiment, 'unclassified') AS sentiment, count(*)::int AS count
       FROM mentions WHERE ${prevWhere} GROUP BY 1`,
      prevParams
    ),
    pool.query(
      `SELECT COALESCE(category, 'unclassified') AS category, count(*)::int AS count
       FROM mentions WHERE ${prevWhere} GROUP BY 1`,
      prevParams
    ),
    pool.query(
      `SELECT COALESCE(category, 'unclassified') AS category, count(*)::int AS count
       FROM mentions WHERE ${prevWhere} AND sentiment = 'negative' GROUP BY 1`,
      prevParams
    )
  ]);

  const total = totalRes.rows[0].total;

  // Sentiment totals for the period, derived from the same day x sentiment
  // rows the time series uses -- guarantees these reconcile with each other
  // by construction rather than by two separately-written queries agreeing.
  const sentimentTotals = { positive: 0, neutral: 0, negative: 0, unclassified: 0 };
  const byDay = new Map();
  for (const row of dayRes.rows) {
    const day = row.day.toISOString().slice(0, 10);
    const key = ['positive', 'neutral', 'negative'].includes(row.sentiment) ? row.sentiment : 'unclassified';
    sentimentTotals[key] += row.count;
    if (!byDay.has(day)) byDay.set(day, { positive: 0, neutral: 0, negative: 0, unclassified: 0 });
    byDay.get(day)[key] += row.count;
  }

  const pct = (n) => (total > 0 ? Math.round((n / total) * 1000) / 10 : 0);
  const sentiment = {
    positive: { count: sentimentTotals.positive, pct: pct(sentimentTotals.positive) },
    neutral: { count: sentimentTotals.neutral, pct: pct(sentimentTotals.neutral) },
    negative: { count: sentimentTotals.negative, pct: pct(sentimentTotals.negative) },
    unclassified: { count: sentimentTotals.unclassified, pct: pct(sentimentTotals.unclassified) }
  };

  // Per-category sentiment split (for the Categories view) -- built the same
  // way as the overall sentiment totals above, so each category's own
  // positive+neutral+negative+unclassified always sums to that category's
  // count, which in turn always sums to the filtered total.
  const categorySentiment = new Map();
  for (const row of categorySentimentRes.rows) {
    if (!categorySentiment.has(row.category)) {
      categorySentiment.set(row.category, { positive: 0, neutral: 0, negative: 0, unclassified: 0 });
    }
    const key = ['positive', 'neutral', 'negative'].includes(row.sentiment) ? row.sentiment : 'unclassified';
    categorySentiment.get(row.category)[key] += row.count;
  }

  const categories = CATEGORIES.map((c) => ({
    category: c.value,
    label: c.label,
    count: categoryRes.rows.find((r) => r.category === c.value)?.count || 0,
    sentiment: categorySentiment.get(c.value) || { positive: 0, neutral: 0, negative: 0, unclassified: 0 }
  }));

  const todayStr = melbourneDateString(new Date());
  const dayRange = buildDayRange(filters.from, filters.to);
  const timeSeries = dayRange.map((day) => {
    const d = byDay.get(day) || { positive: 0, neutral: 0, negative: 0, unclassified: 0 };
    const dayTotal = d.positive + d.neutral + d.negative + d.unclassified;
    return { day, total: dayTotal, positive: d.positive, neutral: d.neutral, negative: d.negative, partial: day === todayStr };
  });

  const prevSentimentTotals = { positive: 0, neutral: 0, negative: 0, unclassified: 0 };
  for (const row of prevSentimentRes.rows) {
    const key = ['positive', 'neutral', 'negative'].includes(row.sentiment) ? row.sentiment : 'unclassified';
    prevSentimentTotals[key] += row.count;
  }
  const prevTotal = prevTotalRes.rows[0].total;
  const prevPct = (n) => (prevTotal > 0 ? Math.round((n / prevTotal) * 1000) / 10 : 0);

  res.json({
    period: { from: filters.from.toISOString(), to: filters.to.toISOString(), days: filters.days },
    total,
    sentiment,
    categories,
    bySource: sourceRes.rows,
    timeSeries,
    negativeByCategory: CATEGORIES.map((c) => ({
      category: c.value,
      label: c.label,
      count: categoryNegRes.rows.find((r) => r.category === c.value)?.count || 0
    })),
    previousPeriod: {
      total: prevTotal,
      totalChangePct: prevTotal > 0 ? Math.round(((total - prevTotal) / prevTotal) * 1000) / 10 : null,
      sentiment: {
        positive: { count: prevSentimentTotals.positive, pct: prevPct(prevSentimentTotals.positive) },
        neutral: { count: prevSentimentTotals.neutral, pct: prevPct(prevSentimentTotals.neutral) },
        negative: { count: prevSentimentTotals.negative, pct: prevPct(prevSentimentTotals.negative) },
        unclassified: { count: prevSentimentTotals.unclassified, pct: prevPct(prevSentimentTotals.unclassified) }
      },
      categories: CATEGORIES.map((c) => ({
        category: c.value,
        label: c.label,
        count: prevCategoryRes.rows.find((r) => r.category === c.value)?.count || 0
      })),
      negativeByCategory: CATEGORIES.map((c) => ({
        category: c.value,
        label: c.label,
        count: prevCategoryNegRes.rows.find((r) => r.category === c.value)?.count || 0
      }))
    }
  });
});

// Manual data-reset utility for use during tuning -- gated on ADMIN_TOKEN so
// it's harmless without it. Not exposed anywhere in the UI; call directly.
app.post('/admin/reset-mentions', express.json(), requireAdmin, async (req, res) => {
  const before = await pool.query('SELECT count(*) FROM mentions');
  await pool.query('TRUNCATE TABLE mentions, ingest_runs RESTART IDENTITY');
  res.json({ ok: true, mentionsDeleted: Number(before.rows[0].count) });
});

// Manual category override -- category_source='manual' rows are excluded
// from both the backfill job and reclassify-unclassified below, so this
// choice persists across future automated (re)classification.
app.post('/admin/mentions/:id/category', express.json(), requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const { category } = req.body || {};
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid mention id' });
  if (!CATEGORY_VALUES.includes(category)) {
    return res.status(400).json({ error: `category must be one of: ${CATEGORY_VALUES.join(', ')}` });
  }
  await setManualCategory(id, category);
  res.json({ ok: true, id, category, category_source: 'manual' });
});

// On-demand re-attempt for rows already sitting at category='unclassified'
// (not the bulk/resumable backfill -- that's `npm run backfill-categories`
// for rows with no category at all). Capped at 100/call to keep this
// synchronous HTTP request's runtime bounded.
app.post('/admin/reclassify-unclassified', express.json(), requireAdmin, async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(400).json({ error: 'ANTHROPIC_API_KEY not set' });
  }
  const rows = await getUnclassifiedMentions(100);
  const classifications = await classifyMentions(rows);
  for (const c of classifications) {
    await updateCategory(c.id, { category: c.category, category_confidence: c.category_confidence });
  }
  res.json({ ok: true, attempted: rows.length, reclassified: classifications.length });
});

// One page of the resumable backfill for rows with NO category at all
// (category IS NULL) -- distinct from reclassify-unclassified above, which
// only retries rows the classifier already looked at and gave up on.
// `npm run backfill-categories` does the same thing to completion from a
// shell; this exposes one page of it over HTTP for when shell access isn't
// available (e.g. triggering it from the deployed dashboard). Same cursor
// logic as getMentionsNeedingCategoryBackfill: the client advances afterId
// to `lastId` and calls again until `done` is true.
app.post('/admin/backfill-categories', express.json(), requireAdmin, async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(400).json({ error: 'ANTHROPIC_API_KEY not set' });
  }
  const afterId = Number(req.body?.afterId) || 0;
  const rows = await getMentionsNeedingCategoryBackfill(100, afterId);
  if (rows.length === 0) {
    return res.json({ ok: true, attempted: 0, backfilled: 0, lastId: afterId, done: true });
  }
  const classifications = await classifyMentions(rows);
  for (const c of classifications) {
    await updateCategory(c.id, { category: c.category, category_confidence: c.category_confidence });
  }
  res.json({ ok: true, attempted: rows.length, backfilled: classifications.length, lastId: rows[rows.length - 1].id, done: rows.length < 100 });
});

const port = process.env.PORT || 3000;

initSchemaWithRetry()
  .then(() => {
    app.listen(port, () => console.log(`Dashboard listening on port ${port}`));
  })
  .catch((err) => {
    console.error('Failed to init schema:', err);
    process.exit(1);
  });
