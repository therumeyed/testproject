const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost')
    ? false
    : { rejectUnauthorized: false }
});

async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mentions (
      id SERIAL PRIMARY KEY,
      source TEXT NOT NULL,
      external_id TEXT NOT NULL,
      url TEXT,
      title TEXT,
      snippet TEXT,
      author TEXT,
      posted_at TIMESTAMPTZ,
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      raw_data JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(source, external_id)
    );
    ALTER TABLE mentions ADD COLUMN IF NOT EXISTS sentiment TEXT;
    ALTER TABLE mentions ADD COLUMN IF NOT EXISTS severity TEXT;
    ALTER TABLE mentions ADD COLUMN IF NOT EXISTS sentiment_reason TEXT;
    ALTER TABLE mentions ADD COLUMN IF NOT EXISTS alerted_at TIMESTAMPTZ;
    ALTER TABLE mentions ADD COLUMN IF NOT EXISTS relevant BOOLEAN;
    ALTER TABLE mentions ADD COLUMN IF NOT EXISTS category TEXT;
    ALTER TABLE mentions ADD COLUMN IF NOT EXISTS category_confidence REAL;
    ALTER TABLE mentions ADD COLUMN IF NOT EXISTS category_source TEXT;
    CREATE INDEX IF NOT EXISTS idx_mentions_category ON mentions(category);
    CREATE INDEX IF NOT EXISTS idx_mentions_first_seen ON mentions(first_seen_at);
    CREATE INDEX IF NOT EXISTS idx_mentions_source ON mentions(source);
    CREATE INDEX IF NOT EXISTS idx_mentions_sentiment ON mentions(sentiment);

    CREATE TABLE IF NOT EXISTS ingest_runs (
      id SERIAL PRIMARY KEY,
      source TEXT NOT NULL,
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      finished_at TIMESTAMPTZ,
      new_count INTEGER,
      error TEXT
    );

    DROP TABLE IF EXISTS trend_queries;

    -- Google Trends data via DataForSEO's Google Trends Explore API (see
    -- src/trends.js and src/dataForSeoClient.js) -- there is no official
    -- Trends API, so this is a paid third-party proxy over it, run on a
    -- schedule (see ingest.js) rather than live per dashboard request.
    --
    -- Numeric interest-over-time observations, one row per keyword/date/
    -- series. "series" keeps the daily-90-day and weekly-5-year fetches
    -- fully separate: each is normalised by Google against its own request
    -- window, so the same keyword+date can have two different, mutually
    -- incomparable values depending which request it came from. Upserted by
    -- (keyword, series, observation_date) so re-fetching the same window
    -- corrects rather than duplicates.
    CREATE TABLE IF NOT EXISTS trend_observations (
      id SERIAL PRIMARY KEY,
      keyword TEXT NOT NULL,
      series TEXT NOT NULL,
      observation_date DATE NOT NULL,
      value INTEGER,
      fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (keyword, series, observation_date)
    );
    CREATE INDEX IF NOT EXISTS idx_trend_observations_lookup ON trend_observations(keyword, series, observation_date);

    -- Related-query snapshots (top + rising) per seed keyword per fetch --
    -- appended rather than upserted, since each fetch is a fresh top-N list
    -- rather than a continuous series; callers read the most recent
    -- fetched_at per (seed_keyword, series) so a failed fetch just leaves
    -- the previous snapshot in place rather than the panel going empty.
    CREATE TABLE IF NOT EXISTS trend_related_queries (
      id SERIAL PRIMARY KEY,
      seed_keyword TEXT NOT NULL,
      series TEXT NOT NULL,
      query_type TEXT NOT NULL,
      query TEXT NOT NULL,
      value INTEGER,
      is_breakout BOOLEAN NOT NULL DEFAULT false,
      fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_trend_related_queries_lookup ON trend_related_queries(seed_keyword, series, fetched_at);

    -- Raw API responses, kept for audit/debugging -- exactly what was
    -- requested (keyword group, timeframe) and what came back, regardless
    -- of whether it was later parsed successfully.
    CREATE TABLE IF NOT EXISTS trends_raw_results (
      id SERIAL PRIMARY KEY,
      source TEXT NOT NULL DEFAULT 'dataforseo',
      request_type TEXT NOT NULL,
      keyword_group TEXT NOT NULL,
      timeframe TEXT NOT NULL,
      requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      raw_result JSONB
    );

    -- One row per schedule ('daily', 'weekly') tracking the last attempt/
    -- success so the dashboard can always show "Last updated [date]" from
    -- the last successful fetch even when the most recent attempt (and its
    -- one retry, handled in-process -- see ingest.js) both failed.
    CREATE TABLE IF NOT EXISTS trends_fetch_status (
      request_type TEXT PRIMARY KEY,
      last_attempt_at TIMESTAMPTZ,
      last_success_at TIMESTAMPTZ,
      last_status_code INTEGER,
      last_error TEXT
    );
  `);
}

// On a fresh Blueprint deploy the DB, web service, and cron job are all
// created together, so the DB can still be spinning up when a service makes
// its first connection -- retry instead of crashing on that first attempt.
async function initSchemaWithRetry(maxAttempts = 10, delayMs = 3000) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await initSchema();
      return;
    } catch (err) {
      if (attempt === maxAttempts) throw err;
      console.warn(`[db] schema init attempt ${attempt}/${maxAttempts} failed (${err.message}), retrying in ${delayMs}ms...`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

// ON CONFLICT DO NOTHING preserves first_seen_at from the original insert,
// which is what makes "first time we saw it" dedupe work across daily runs.
// Returns only the rows that were actually newly inserted (with id, source,
// title, snippet, url) so callers can classify/alert on exactly those,
// never on rows that were already seen in a previous run.
async function insertMentions(mentions) {
  const insertedRows = [];
  for (const m of mentions) {
    const res = await pool.query(
      `INSERT INTO mentions (source, external_id, url, title, snippet, author, posted_at, raw_data)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (source, external_id) DO NOTHING
       RETURNING id, source, title, snippet, url`,
      [
        m.source,
        m.external_id,
        m.url || null,
        m.title || null,
        m.snippet || null,
        m.author || null,
        m.posted_at || null,
        m.raw_data ? JSON.stringify(m.raw_data) : null
      ]
    );
    if (res.rowCount > 0) insertedRows.push(res.rows[0]);
  }
  return insertedRows;
}

// Called once per freshly-classified mention (from ingest.js or the backfill
// job) -- always category_source='ai' here. Manual overrides go through
// setManualCategory() instead, and both the backfill and reclassify queries
// below exclude category_source='manual' rows so a manual choice is never
// clobbered by a future automated pass.
async function updateSentiment(id, { sentiment, severity, reason, relevant, category, category_confidence }) {
  await pool.query(
    `UPDATE mentions
     SET sentiment = $2, severity = $3, sentiment_reason = $4, relevant = $5,
         category = $6, category_confidence = $7, category_source = 'ai'
     WHERE id = $1`,
    [
      id,
      sentiment || null,
      severity || null,
      reason || null,
      relevant === false ? false : true,
      category || null,
      typeof category_confidence === 'number' ? category_confidence : null
    ]
  );
}

async function markAlerted(id) {
  await pool.query(`UPDATE mentions SET alerted_at = now() WHERE id = $1`, [id]);
}

// Backfill-only write path -- deliberately narrower than updateSentiment()
// so re-categorizing an old mention never touches its existing
// sentiment/severity/relevant, which may already have been reviewed/acted on.
async function updateCategory(id, { category, category_confidence }) {
  await pool.query(
    `UPDATE mentions SET category = $2, category_confidence = $3, category_source = 'ai' WHERE id = $1`,
    [id, category || null, typeof category_confidence === 'number' ? category_confidence : null]
  );
}

// Existing rows with no category yet (pre-dates this feature, or a prior
// classification attempt failed). Cursor-based (afterId) rather than a bare
// "WHERE category IS NULL LIMIT N" repeated query -- if any item in a page
// fails to classify and stays NULL, a stateless query would return that same
// stuck page forever. Advancing past the highest id seen each page
// guarantees forward progress through the table within one run; a fresh
// invocation (afterId back to 0) is what actually retries anything still
// NULL, which is the intended "resume after failure" behaviour.
async function getMentionsNeedingCategoryBackfill(limit = 50, afterId = 0) {
  const res = await pool.query(
    `SELECT id, source, title, snippet FROM mentions WHERE category IS NULL AND id > $2 ORDER BY id ASC LIMIT $1`,
    [limit, afterId]
  );
  return res.rows;
}

// Rows the classifier already looked at but couldn't confidently categorize
// -- for the "reclassify unclassified" action. Excludes manual overrides
// (someone may have deliberately set category to 'unclassified').
async function getUnclassifiedMentions(limit = 50) {
  const res = await pool.query(
    `SELECT id, source, title, snippet FROM mentions
     WHERE category = 'unclassified' AND category_source IS DISTINCT FROM 'manual'
     ORDER BY id ASC LIMIT $1`,
    [limit]
  );
  return res.rows;
}

async function setManualCategory(id, category) {
  await pool.query(
    `UPDATE mentions SET category = $2, category_source = 'manual', category_confidence = NULL WHERE id = $1`,
    [id, category]
  );
}

// All negative mentions first seen on the current Melbourne calendar day,
// regardless of which of the day's several runs found them -- used for the
// once-daily digest so it's a true day rollup, not just the triggering run's
// own findings.
async function getTodaysNegativeMentions() {
  const res = await pool.query(`
    SELECT id, source, title, snippet, url, severity, sentiment_reason AS reason, category
    FROM mentions
    WHERE sentiment = 'negative'
      AND relevant IS DISTINCT FROM false
      AND (first_seen_at AT TIME ZONE 'Australia/Melbourne')::date = (now() AT TIME ZONE 'Australia/Melbourne')::date
    ORDER BY first_seen_at ASC
  `);
  return res.rows;
}

// Upserts interest-over-time observations by (keyword, series,
// observation_date) -- re-fetching the same window corrects existing rows
// (value, fetched_at) instead of duplicating them.
async function upsertTrendObservations(rows) {
  for (const r of rows) {
    await pool.query(
      `INSERT INTO trend_observations (keyword, series, observation_date, value, fetched_at)
       VALUES ($1,$2,$3,$4,now())
       ON CONFLICT (keyword, series, observation_date)
       DO UPDATE SET value = EXCLUDED.value, fetched_at = now()`,
      [r.keyword, r.series, r.observationDate, r.value]
    );
  }
}

// Ordered by date so callers can slice off the trailing N days for the
// rolling-average calculations without re-sorting.
async function getTrendObservations(series, keywords) {
  const res = await pool.query(
    `SELECT keyword, observation_date AS "observationDate", value
     FROM trend_observations WHERE series = $1 AND keyword = ANY($2::text[])
     ORDER BY keyword ASC, observation_date ASC`,
    [series, keywords]
  );
  return res.rows;
}

// Related-query snapshots are appended, not upserted (see schema comment),
// all sharing one fetched_at so "the latest snapshot per seed" is
// unambiguous even if individual inserts take a few milliseconds apart.
async function insertTrendRelatedQueries(rows) {
  if (rows.length === 0) return;
  const fetchedAt = new Date();
  for (const r of rows) {
    await pool.query(
      `INSERT INTO trend_related_queries (seed_keyword, series, query_type, query, value, is_breakout, fetched_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [r.seedKeyword, r.series, r.queryType, r.query, r.value ?? null, !!r.isBreakout, fetchedAt]
    );
  }
  // Light retention -- these are point-in-time snapshots, not a series
  // anyone needs full history of; keep the last 90 days per (seed, series)
  // trivially bounded rather than growing forever.
  await pool.query(`DELETE FROM trend_related_queries WHERE fetched_at < now() - interval '90 days'`);
}

// Only the most recent fetch per (seed_keyword, series) -- a failed fetch
// simply leaves the prior snapshot as "most recent" rather than the panel
// going empty.
async function getLatestTrendRelatedQueries(series) {
  const res = await pool.query(
    `SELECT t.seed_keyword AS "seedKeyword", t.query_type AS "queryType", t.query,
            t.value, t.is_breakout AS "isBreakout", t.fetched_at AS "fetchedAt"
     FROM trend_related_queries t
     INNER JOIN (
       SELECT seed_keyword, max(fetched_at) AS max_fetched_at
       FROM trend_related_queries WHERE series = $1
       GROUP BY seed_keyword
     ) latest ON latest.seed_keyword = t.seed_keyword AND latest.max_fetched_at = t.fetched_at
     WHERE t.series = $1
     ORDER BY t.seed_keyword ASC, t.is_breakout DESC, t.value DESC NULLS LAST`,
    [series]
  );
  return res.rows;
}

async function insertTrendsRawResult({ requestType, keywordGroup, timeframe, rawResult }) {
  await pool.query(
    `INSERT INTO trends_raw_results (request_type, keyword_group, timeframe, raw_result) VALUES ($1,$2,$3,$4)`,
    [requestType, keywordGroup, timeframe, JSON.stringify(rawResult)]
  );
}

async function recordTrendsFetchAttempt({ requestType, success, statusCode, error }) {
  await pool.query(
    `INSERT INTO trends_fetch_status (request_type, last_attempt_at, last_success_at, last_status_code, last_error)
     VALUES ($1, now(), CASE WHEN $2 THEN now() ELSE NULL END, $3, $4)
     ON CONFLICT (request_type) DO UPDATE SET
       last_attempt_at = now(),
       last_success_at = CASE WHEN $2 THEN now() ELSE trends_fetch_status.last_success_at END,
       last_status_code = $3,
       last_error = $4`,
    [requestType, success, statusCode ?? null, error || null]
  );
}

async function getTrendsFetchStatus(requestType) {
  const res = await pool.query(
    `SELECT request_type AS "requestType", last_attempt_at AS "lastAttemptAt", last_success_at AS "lastSuccessAt",
            last_status_code AS "lastStatusCode", last_error AS "lastError"
     FROM trends_fetch_status WHERE request_type = $1`,
    [requestType]
  );
  return res.rows[0] || null;
}

module.exports = {
  pool,
  initSchema,
  initSchemaWithRetry,
  insertMentions,
  updateSentiment,
  markAlerted,
  getTodaysNegativeMentions,
  getMentionsNeedingCategoryBackfill,
  getUnclassifiedMentions,
  setManualCategory,
  upsertTrendObservations,
  getTrendObservations,
  insertTrendRelatedQueries,
  getLatestTrendRelatedQueries,
  insertTrendsRawResult,
  recordTrendsFetchAttempt,
  getTrendsFetchStatus,
  updateCategory
};
