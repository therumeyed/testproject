require('dotenv').config();
const express = require('express');
const path = require('path');
const { pool, initSchema } = require('./db');

const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/health', (req, res) => res.json({ ok: true }));

app.get('/api/mentions', async (req, res) => {
  const days = Number(req.query.days) || 14;
  const limit = Math.min(Number(req.query.limit) || 200, 1000);
  const params = [days, limit];
  let where = `first_seen_at >= now() - ($1 || ' days')::interval`;

  if (req.query.source) {
    params.push(req.query.source);
    where += ` AND source = $${params.length}`;
  }

  const result = await pool.query(
    `SELECT id, source, url, title, snippet, author, posted_at, first_seen_at
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
     WHERE first_seen_at >= now() - ($1 || ' days')::interval
     GROUP BY source, day
     ORDER BY day ASC`,
    [days]
  );
  res.json(result.rows);
});

const port = process.env.PORT || 3000;

initSchema()
  .then(() => {
    app.listen(port, () => console.log(`Dashboard listening on port ${port}`));
  })
  .catch((err) => {
    console.error('Failed to init schema:', err);
    process.exit(1);
  });
