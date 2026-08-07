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
    CREATE INDEX IF NOT EXISTS idx_mentions_first_seen ON mentions(first_seen_at);
    CREATE INDEX IF NOT EXISTS idx_mentions_source ON mentions(source);

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
async function insertMentions(mentions) {
  let inserted = 0;
  for (const m of mentions) {
    const res = await pool.query(
      `INSERT INTO mentions (source, external_id, url, title, snippet, author, posted_at, raw_data)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (source, external_id) DO NOTHING
       RETURNING id`,
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
    if (res.rowCount > 0) inserted++;
  }
  return inserted;
}

module.exports = { pool, initSchema, initSchemaWithRetry, insertMentions };
