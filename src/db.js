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

async function updateSentiment(id, { sentiment, severity, reason, relevant }) {
  await pool.query(
    `UPDATE mentions SET sentiment = $2, severity = $3, sentiment_reason = $4, relevant = $5 WHERE id = $1`,
    [id, sentiment || null, severity || null, reason || null, relevant === false ? false : true]
  );
}

async function markAlerted(id) {
  await pool.query(`UPDATE mentions SET alerted_at = now() WHERE id = $1`, [id]);
}

// All negative mentions first seen on the current Melbourne calendar day,
// regardless of which of the day's several runs found them -- used for the
// once-daily digest so it's a true day rollup, not just the triggering run's
// own findings.
async function getTodaysNegativeMentions() {
  const res = await pool.query(`
    SELECT id, source, title, snippet, url, severity, sentiment_reason AS reason
    FROM mentions
    WHERE sentiment = 'negative'
      AND relevant IS DISTINCT FROM false
      AND (first_seen_at AT TIME ZONE 'Australia/Melbourne')::date = (now() AT TIME ZONE 'Australia/Melbourne')::date
    ORDER BY first_seen_at ASC
  `);
  return res.rows;
}

module.exports = {
  pool,
  initSchema,
  initSchemaWithRetry,
  insertMentions,
  updateSentiment,
  markAlerted,
  getTodaysNegativeMentions
};
