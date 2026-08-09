const { pool } = require('../db');
const { SEED_TERMS, SEED_DISCOVERY_QUERIES, SEED_SUBREDDITS } = require('./taxonomy');
const { DEFAULTS } = require('./appConfig');

// Idempotent: only inserts rows/keys that don't already exist, so admin
// edits made after first boot are never clobbered by a redeploy.
async function seedConfig() {
  for (const t of SEED_TERMS) {
    await pool.query(
      `INSERT INTO taxonomy_terms (parent_category, subcategory, term, term_type)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (parent_category, term, term_type) DO NOTHING`,
      [t.parent_category, t.subcategory || null, t.term, t.term_type]
    );
  }

  for (const q of SEED_DISCOVERY_QUERIES) {
    for (const platform of ['tiktok', 'instagram', 'reddit']) {
      await pool.query(
        `INSERT INTO discovery_queries (platform, query_type, query_text, category_hint, status, source)
         VALUES ($1, $2, $3, $4, 'approved', 'seed')
         ON CONFLICT (platform, query_type, query_text) DO NOTHING`,
        [platform, q.query_type, q.query_text, q.category_hint]
      );
    }
  }

  for (const sub of SEED_SUBREDDITS) {
    await pool.query(
      `INSERT INTO discovery_queries (platform, query_type, query_text, category_hint, status, source)
       VALUES ('reddit', 'subreddit', $1, 'all', 'approved', 'seed')
       ON CONFLICT (platform, query_type, query_text) DO NOTHING`,
      [sub]
    );
  }

  for (const [key, value] of Object.entries(DEFAULTS)) {
    await pool.query(
      `INSERT INTO app_config (key, value, updated_by)
       VALUES ($1, $2, 'system_seed')
       ON CONFLICT (key) DO NOTHING`,
      [key, JSON.stringify(value)]
    );
  }
}

async function getConfig(key) {
  const res = await pool.query('SELECT value FROM app_config WHERE key = $1', [key]);
  if (res.rows.length === 0) return DEFAULTS[key];
  return res.rows[0].value;
}

async function getAllConfig() {
  const res = await pool.query('SELECT key, value, updated_at, updated_by FROM app_config ORDER BY key');
  return res.rows;
}

async function setConfig(key, value, updatedBy) {
  await pool.query(
    `INSERT INTO app_config (key, value, updated_by, updated_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_by = $3, updated_at = now()`,
    [key, JSON.stringify(value), updatedBy || null]
  );
}

module.exports = { seedConfig, getConfig, getAllConfig, setConfig };
