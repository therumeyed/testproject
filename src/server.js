require('dotenv').config();
const express = require('express');
const path = require('path');
const { pool, initSchemaWithRetry } = require('./db');

const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/health', (req, res) => res.json({ ok: true }));

app.get('/api/mentions', async (req, res) => {
  const days = Number(req.query.days) || 14;
  const limit = Math.min(Number(req.query.limit) || 200, 1000);
  const params = [days, limit];
  // ?discarded=1 flips this to show only items marked irrelevant, for
  // auditing what the relevance filter is catching (and why, via
  // sentiment_reason) -- default view hides them everywhere else.
  let where = req.query.discarded
    ? `relevant = false`
    : `relevant IS DISTINCT FROM false`;
  where += ` AND first_seen_at >= now() - ($1 || ' days')::interval`;

  if (req.query.source) {
    params.push(req.query.source);
    where += ` AND source = $${params.length}`;
  }
  if (req.query.sentiment) {
    params.push(req.query.sentiment);
    where += ` AND sentiment = $${params.length}`;
  }

  const result = await pool.query(
    `SELECT id, source, url, title, snippet, author, posted_at, first_seen_at, sentiment, severity, sentiment_reason
     FROM mentions WHERE ${where}
     ORDER BY first_seen_at DESC LIMIT $2`,
    params
  );
  res.json(result.rows);
});

app.get('/api/stats', async (req, res) => {
  const days = Number(req.query.days) || 14;
  const result = await pool.query(
    `SELECT source, date_trunc('day', first_seen_at) AS day, count(*)::int AS count
     FROM mentions
     WHERE first_seen_at >= now() - ($1 || ' days')::interval AND relevant IS DISTINCT FROM false
     GROUP BY source, day
     ORDER BY day ASC`,
    [days]
  );
  res.json(result.rows);
});

app.get('/api/sentiment-stats', async (req, res) => {
  const days = Number(req.query.days) || 14;
  const result = await pool.query(
    `SELECT COALESCE(sentiment, 'unclassified') AS sentiment, count(*)::int AS count
     FROM mentions
     WHERE first_seen_at >= now() - ($1 || ' days')::interval AND relevant IS DISTINCT FROM false
     GROUP BY sentiment`,
    [days]
  );
  res.json(result.rows);
});

// Manual data-reset utility for use during tuning -- gated on ADMIN_TOKEN so
// it's harmless without it. Not exposed anywhere in the UI; call directly.
app.post('/admin/reset-mentions', express.json(), async (req, res) => {
  const token = req.get('Authorization')?.replace(/^Bearer\s+/i, '');
  if (!process.env.ADMIN_TOKEN || token !== process.env.ADMIN_TOKEN) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const before = await pool.query('SELECT count(*) FROM mentions');
  await pool.query('TRUNCATE TABLE mentions, ingest_runs RESTART IDENTITY');
  res.json({ ok: true, mentionsDeleted: Number(before.rows[0].count) });
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
