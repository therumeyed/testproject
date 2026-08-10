require('dotenv').config();
const express = require('express');
const path = require('path');
const { pool, initSchemaForever } = require('./db');
const { seedConfig, getConfig, getAllConfig, setConfig } = require('./config/seedConfig');
const { listTrends, getTrendDetail, ACTION_LABELS } = require('./lib/trendQueries');
const { attachIdentity } = require('./lib/auth');
const { toCsv } = require('./lib/csv');
const runStatus = require('./lib/runStatus');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use(attachIdentity);

async function writeAudit(req, action, entityType, entityId, before, after, reason) {
  await pool.query(
    `INSERT INTO audit_logs (user_email, action, entity_type, entity_id, before, after, reason) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [req.user?.email || 'unknown', action, entityType, entityId ?? null, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, reason || null]
  );
}

// ---------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------
// Set once the database schema is confirmed reachable (see bottom of this
// file). Deliberately independent of app.listen() -- on a fresh Render
// Blueprint deploy the web service and a brand-new Postgres instance start
// at the same time, and first-time DB provisioning can take over a minute.
// The port must open immediately regardless, or Render's port scan and
// health checks have nothing to find while we wait.
let dbReady = false;

app.get('/api/health', (req, res) => res.json({ ok: true, dbReady }));

app.get('/api/me', (req, res) => res.json(req.user));

// Everything below touches the database, so fail fast and clearly instead
// of letting individual routes throw ECONNREFUSED as 500s while it's still
// starting up.
app.use('/api', (req, res, next) => {
  if (!dbReady) return res.status(503).json({ error: 'starting_up', message: 'The service is still starting up. Please retry in a few seconds.' });
  next();
});

// ---------------------------------------------------------------------
// Source health
// ---------------------------------------------------------------------
app.get('/api/source-health', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (platform) platform, status, started_at, finished_at, items_fetched, items_new, error_message
     FROM source_runs ORDER BY platform, started_at DESC`
  );
  res.json(rows);
});

app.get('/api/config/public', async (req, res) => {
  const [durability, lifecycle, marketMode] = await Promise.all([
    getConfig('durability_thresholds'), getConfig('lifecycle_thresholds'), getConfig('market_mode')
  ]);
  res.json({ durabilityThresholds: durability, lifecycleThresholds: lifecycle, marketMode, actionLabels: ACTION_LABELS });
});

// ---------------------------------------------------------------------
// Trends
// ---------------------------------------------------------------------
app.get('/api/trends', async (req, res) => {
  try {
    const trends = await listTrends({
      category: req.query.category, brandFit: req.query.brandFit, marketAuState: req.query.auState,
      lifecycleStage: req.query.stage, durabilityLabel: req.query.durability, search: req.query.q,
      minSocialScore: req.query.minSocial, minBuyingScore: req.query.minBuying, minConfidence: req.query.minConfidence,
      includeSuppressed: req.user.role === 'admin' && req.query.includeSuppressed === 'true'
    });
    res.json(trends);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'failed to list trends' });
  }
});

app.get('/api/trends/:id', async (req, res) => {
  const trend = await getTrendDetail(Number(req.params.id));
  if (!trend) return res.status(404).json({ error: 'not_found' });
  res.json(trend);
});

app.get('/api/compare', async (req, res) => {
  const ids = (req.query.ids || '').split(',').map(Number).filter(Boolean).slice(0, 5);
  if (ids.length < 2) return res.status(400).json({ error: 'provide 2-5 ids' });
  const trends = await Promise.all(ids.map((id) => getTrendDetail(id)));
  res.json(trends.filter(Boolean));
});

app.post('/api/trends/:id/feedback', async (req, res) => {
  const { isRelevant, comment } = req.body || {};
  await pool.query(
    `INSERT INTO user_feedback (trend_topic_id, user_email, is_relevant, comment) VALUES ($1,$2,$3,$4)`,
    [req.params.id, req.user.email, isRelevant ?? null, comment || null]
  );
  res.json({ ok: true });
});

// ---------------------------------------------------------------------
// Recommendations (Social Content Desk / Buying Desk workflow)
// ---------------------------------------------------------------------
app.get('/api/recommendations', async (req, res) => {
  const type = req.query.type === 'buying_opportunity' ? 'buying_opportunity' : 'social_idea';
  const params = [type];
  let where = `r.rec_type = $1`;
  if (req.query.status) { params.push(req.query.status); where += ` AND r.status = $${params.length}`; }
  if (req.query.category) { params.push(req.query.category); where += ` AND t.parent_category = $${params.length}`; }

  const { rows } = await pool.query(
    `SELECT r.id, r.rec_type, r.payload, r.status, r.owner, r.notes, r.created_at, r.updated_at,
            t.id AS trend_id, t.name AS trend_name, t.parent_category, t.subcategory, t.market_au_state,
            t.first_detected_date,
            ts.social_score, ts.buying_score, ts.confidence_score, ts.lifecycle_stage, ts.durability_label,
            ts.consecutive_active_days
     FROM trend_recommendations r
     JOIN trend_topics t ON t.id = r.trend_topic_id
     LEFT JOIN LATERAL (SELECT * FROM trend_scores WHERE trend_topic_id = t.id ORDER BY score_date DESC LIMIT 1) ts ON true
     WHERE ${where} AND t.status = 'active'
     ORDER BY COALESCE(ts.social_score,0) + COALESCE(ts.buying_score,0) DESC`,
    params
  );
  res.json(rows);
});

app.patch('/api/recommendations/:id', async (req, res) => {
  const { status, owner, notes } = req.body || {};
  const { rows: before } = await pool.query(`SELECT * FROM trend_recommendations WHERE id = $1`, [req.params.id]);
  if (before.length === 0) return res.status(404).json({ error: 'not_found' });

  await pool.query(
    `UPDATE trend_recommendations SET
       status = COALESCE($2, status), owner = COALESCE($3, owner), notes = COALESCE($4, notes), updated_at = now()
     WHERE id = $1`,
    [req.params.id, status || null, owner ?? null, notes ?? null]
  );
  if (status && status !== before[0].status) {
    await pool.query(
      `INSERT INTO workflow_actions (entity_type, entity_id, action, from_status, to_status, user_email, note)
       VALUES ('recommendation', $1, 'status_change', $2, $3, $4, $5)`,
      [req.params.id, before[0].status, status, req.user.email, notes || null]
    );
  }
  res.json({ ok: true });
});

// ---------------------------------------------------------------------
// Trend History
// ---------------------------------------------------------------------
app.get('/api/history/dates', async (req, res) => {
  const { rows } = await pool.query(`SELECT DISTINCT score_date FROM trend_scores ORDER BY score_date DESC LIMIT 90`);
  res.json(rows.map((r) => r.score_date));
});

app.get('/api/history', async (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  const { rows } = await pool.query(
    `SELECT t.id, t.name, t.parent_category, ts.social_score, ts.buying_score, ts.confidence_score,
            ts.lifecycle_stage, ts.durability_label, ts.active_days, ts.consecutive_active_days
     FROM trend_scores ts JOIN trend_topics t ON t.id = ts.trend_topic_id
     WHERE ts.score_date = $1 AND t.status != 'merged'
     ORDER BY COALESCE(ts.social_score,0) + COALESCE(ts.buying_score,0) DESC`,
    [date]
  );
  res.json(rows);
});

app.get('/api/workflow-actions', async (req, res) => {
  const params = [];
  let where = 'true';
  if (req.query.entityType) { params.push(req.query.entityType); where += ` AND entity_type = $${params.length}`; }
  if (req.query.entityId) { params.push(req.query.entityId); where += ` AND entity_id = $${params.length}`; }
  const { rows } = await pool.query(`SELECT * FROM workflow_actions WHERE ${where} ORDER BY created_at DESC LIMIT 200`, params);
  res.json(rows);
});

// ---------------------------------------------------------------------
// Exports (CSV)
// ---------------------------------------------------------------------
app.get('/api/export/trends.csv', async (req, res) => {
  const trends = await listTrends({});
  const csv = toCsv(trends, [
    { label: 'Trend', value: 'name' }, { label: 'Category', value: 'parentCategory' },
    { label: 'Stage', value: 'lifecycleStage' }, { label: 'Durability', value: 'durabilityLabel' },
    { label: 'Age (days)', value: 'trendAgeDays' }, { label: 'Consecutive active days', value: 'consecutiveActiveDays' },
    { label: 'Social score', value: 'socialScore' }, { label: 'Buying score', value: 'buyingScore' },
    { label: 'Confidence', value: 'confidenceScore' }, { label: 'AU validation', value: 'marketAuState' },
    { label: 'Recommended action', value: 'recommendedActionLabel' }
  ]);
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="trend-explorer.csv"');
  res.send(csv);
});

async function exportShortlist(req, res, type) {
  const params = [type];
  const { rows } = await pool.query(
    `SELECT r.payload, r.status, r.owner, t.name AS trend_name, t.parent_category
     FROM trend_recommendations r JOIN trend_topics t ON t.id = r.trend_topic_id
     WHERE r.rec_type = $1 ORDER BY r.created_at DESC`,
    params
  );
  const flat = rows.map((r) => ({ trend: r.trend_name, category: r.parent_category, status: r.status, owner: r.owner, ...r.payload }));
  const columns = type === 'social_idea'
    ? [{ label: 'Trend', value: 'trend' }, { label: 'Idea', value: 'title' }, { label: 'Format', value: 'format' }, { label: 'Hook', value: 'hook' }, { label: 'Effort', value: 'effortLevel' }, { label: 'Shelf life', value: 'shelfLife' }, { label: 'Status', value: 'status' }, { label: 'Owner', value: 'owner' }]
    : [{ label: 'Trend', value: 'trend' }, { label: 'Product opportunity', value: 'productOpportunity' }, { label: 'Attributes', value: 'attributes' }, { label: 'Suggested action', value: 'suggestedAction' }, { label: 'Lead-time risk', value: 'leadTimeRisk' }, { label: 'Status', value: 'status' }, { label: 'Owner', value: 'owner' }];
  const csv = toCsv(flat, columns);
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${type}-shortlist.csv"`);
  res.send(csv);
}
app.get('/api/export/social-shortlist.csv', (req, res) => exportShortlist(req, res, 'social_idea'));
app.get('/api/export/buying-shortlist.csv', (req, res) => exportShortlist(req, res, 'buying_opportunity'));

// ---------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------
const admin = express.Router();

admin.get('/config', async (req, res) => res.json(await getAllConfig()));
admin.put('/config/:key', async (req, res) => {
  const before = await getConfig(req.params.key);
  await setConfig(req.params.key, req.body.value, req.user.email);
  await writeAudit(req, 'config_update', 'app_config', null, { key: req.params.key, value: before }, { key: req.params.key, value: req.body.value });
  res.json({ ok: true });
});

admin.get('/taxonomy', async (req, res) => {
  const { rows } = await pool.query(`SELECT * FROM taxonomy_terms ORDER BY parent_category, term_type, term`);
  res.json(rows);
});
admin.post('/taxonomy', async (req, res) => {
  const { parentCategory, subcategory, term, termType } = req.body || {};
  if (!parentCategory || !term || !termType) return res.status(400).json({ error: 'parentCategory, term, termType required' });
  const { rows } = await pool.query(
    `INSERT INTO taxonomy_terms (parent_category, subcategory, term, term_type) VALUES ($1,$2,$3,$4)
     ON CONFLICT (parent_category, term, term_type) DO UPDATE SET active = true RETURNING *`,
    [parentCategory, subcategory || null, term, termType]
  );
  await writeAudit(req, 'taxonomy_add', 'taxonomy_terms', rows[0].id, null, rows[0]);
  res.json(rows[0]);
});
admin.patch('/taxonomy/:id', async (req, res) => {
  const { active } = req.body || {};
  const { rows } = await pool.query(`UPDATE taxonomy_terms SET active = $2, updated_at = now() WHERE id = $1 RETURNING *`, [req.params.id, active]);
  await writeAudit(req, 'taxonomy_toggle', 'taxonomy_terms', req.params.id, null, rows[0]);
  res.json(rows[0]);
});
admin.delete('/taxonomy/:id', async (req, res) => {
  await pool.query(`DELETE FROM taxonomy_terms WHERE id = $1`, [req.params.id]);
  await writeAudit(req, 'taxonomy_delete', 'taxonomy_terms', req.params.id, null, null);
  res.json({ ok: true });
});

admin.get('/discovery-queries', async (req, res) => {
  const { rows } = await pool.query(`SELECT * FROM discovery_queries ORDER BY status = 'pending_review' DESC, platform, query_text`);
  res.json(rows);
});
admin.post('/discovery-queries', async (req, res) => {
  const { platform, queryType, queryText, categoryHint } = req.body || {};
  const { rows } = await pool.query(
    `INSERT INTO discovery_queries (platform, query_type, query_text, category_hint, status, source, approved_by)
     VALUES ($1,$2,$3,$4,'approved','discovered',$5)
     ON CONFLICT (platform, query_type, query_text) DO UPDATE SET active = true RETURNING *`,
    [platform, queryType, queryText, categoryHint || null, req.user.email]
  );
  await writeAudit(req, 'query_add', 'discovery_queries', rows[0].id, null, rows[0]);
  res.json(rows[0]);
});
admin.patch('/discovery-queries/:id', async (req, res) => {
  const { active, status } = req.body || {};
  const { rows } = await pool.query(
    `UPDATE discovery_queries SET active = COALESCE($2, active), status = COALESCE($3, status), approved_by = $4, updated_at = now() WHERE id = $1 RETURNING *`,
    [req.params.id, active, status || null, req.user.email]
  );
  await writeAudit(req, 'query_update', 'discovery_queries', req.params.id, null, rows[0]);
  res.json(rows[0]);
});

admin.patch('/trends/:id', async (req, res) => {
  const { name, definition, parentCategory, subcategory, attributes, brandFit, status } = req.body || {};
  const { rows: before } = await pool.query(`SELECT * FROM trend_topics WHERE id = $1`, [req.params.id]);
  if (before.length === 0) return res.status(404).json({ error: 'not_found' });
  const { rows } = await pool.query(
    `UPDATE trend_topics SET
       name = COALESCE($2, name), definition = COALESCE($3, definition), parent_category = COALESCE($4, parent_category),
       subcategory = COALESCE($5, subcategory), attributes = COALESCE($6, attributes), brand_fit = COALESCE($7, brand_fit),
       status = COALESCE($8, status), updated_at = now()
     WHERE id = $1 RETURNING *`,
    [req.params.id, name || null, definition || null, parentCategory || null, subcategory || null,
      attributes ? JSON.stringify(attributes) : null, brandFit || null, status || null]
  );
  await writeAudit(req, 'trend_edit', 'trend_topics', req.params.id, before[0], rows[0], req.body.reason);
  res.json(rows[0]);
});

admin.post('/trends/:id/merge', async (req, res) => {
  const { intoId } = req.body || {};
  if (!intoId || Number(intoId) === Number(req.params.id)) return res.status(400).json({ error: 'intoId required and must differ' });
  await pool.query(`UPDATE trend_topics SET status = 'merged', merged_into_id = $2, updated_at = now() WHERE id = $1`, [req.params.id, intoId]);
  await pool.query(
    `INSERT INTO trend_post_matches (trend_topic_id, post_id, match_confidence)
     SELECT $2, post_id, match_confidence FROM trend_post_matches WHERE trend_topic_id = $1 AND post_id IS NOT NULL
     ON CONFLICT (trend_topic_id, post_id) WHERE post_id IS NOT NULL DO NOTHING`,
    [req.params.id, intoId]
  );
  await writeAudit(req, 'trend_merge', 'trend_topics', req.params.id, null, { mergedInto: intoId }, req.body.reason);
  res.json({ ok: true });
});

admin.get('/audit-log', async (req, res) => {
  const { rows } = await pool.query(`SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 200`);
  res.json(rows);
});

admin.get('/products', async (req, res) => {
  const { rows } = await pool.query(`SELECT * FROM sportsgirl_products ORDER BY name`);
  res.json(rows);
});
admin.post('/products', async (req, res) => {
  const p = req.body || {};
  if (!p.sku || !p.name) return res.status(400).json({ error: 'sku and name required' });
  const { rows } = await pool.query(
    `INSERT INTO sportsgirl_products (sku, name, category, subcategory, description, colour, finish, shape, pack_type, price, product_url, image_url, stock_status, lifecycle_state)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT (sku) DO UPDATE SET name=$2, category=$3, subcategory=$4, description=$5, colour=$6, finish=$7, shape=$8, pack_type=$9, price=$10, product_url=$11, image_url=$12, stock_status=$13, lifecycle_state=$14
     RETURNING *`,
    [p.sku, p.name, p.category || null, p.subcategory || null, p.description || null, p.colour || null, p.finish || null,
      p.shape || null, p.packType || null, p.price || null, p.productUrl || null, p.imageUrl || null, p.stockStatus || null, p.lifecycleState || null]
  );
  await writeAudit(req, 'product_upsert', 'sportsgirl_products', rows[0].id, null, rows[0]);
  res.json(rows[0]);
});

admin.post('/products/:trendId/match', async (req, res) => {
  const { productId, matchType, matchReason } = req.body || {};
  const { rows } = await pool.query(
    `INSERT INTO trend_product_matches (trend_topic_id, product_id, match_type, match_reason, corrected_by)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (trend_topic_id, product_id) DO UPDATE SET match_type = $3, match_reason = $4, corrected_by = $5
     RETURNING *`,
    [req.params.trendId, productId, matchType, matchReason || null, req.user.email]
  );
  await writeAudit(req, 'product_match_correct', 'trend_product_matches', rows[0].id, null, rows[0]);
  res.json(rows[0]);
});

admin.get('/rerun-status', (req, res) => res.json(runStatus.getStatus()));

admin.post('/rerun/stop', async (req, res) => {
  if (!runStatus.getStatus().running) return res.status(400).json({ error: 'not_running' });
  runStatus.requestStop();
  await writeAudit(req, 'manual_rerun_stop_requested', 'ingest', null, null, null);
  res.json({ ok: true });
});

async function runPipeline({ skipCollection }) {
  const tiktok = require('./collectors/tiktok');
  const instagram = require('./collectors/instagram');
  const reddit = require('./collectors/reddit');
  const googleTrends = require('./collectors/googleTrends');
  const { runClustering } = require('./cluster');
  const { computeAllDailyMetrics, computeAndStoreScores } = require('./scoring');
  const { runRecommendations } = require('./recommend');
  const today = new Date().toISOString().slice(0, 10);

  // Checked between stages too, not just within each one, so a stop
  // requested near the end of a stage doesn't still kick off the next one.
  if (!skipCollection) {
    for (const collector of [tiktok, instagram, reddit]) {
      if (runStatus.isStopRequested()) break;
      await collector.collect().catch((e) => console.error('[rerun] collector failed:', e.message));
    }
  }
  if (!runStatus.isStopRequested()) {
    await runClustering().catch((e) => console.error('[rerun] clustering failed:', e.message));
  }
  if (!runStatus.isStopRequested()) {
    await googleTrends.collectForActiveTrends().catch((e) => console.error('[rerun] google trends failed:', e.message));
  }
  if (!runStatus.isStopRequested()) {
    await computeAllDailyMetrics(today);
    await computeAndStoreScores(today);
  }
  if (!runStatus.isStopRequested()) {
    await runRecommendations().catch((e) => console.error('[rerun] recommendations failed:', e.message));
  }
  console.log('[rerun] manual pipeline run complete');
}

admin.post('/rerun', async (req, res) => {
  if (runStatus.getStatus().running) {
    return res.status(409).json({ error: 'already_running', message: 'A collection run is already in progress.' });
  }
  res.json({ ok: true, message: 'Manual rerun started.' });
  runStatus.startRun();
  await writeAudit(req, 'manual_rerun_triggered', 'ingest', null, null, null);
  try {
    await runPipeline({ skipCollection: false });
    runStatus.finishRun();
  } catch (err) {
    console.error('[rerun] failed:', err.message);
    runStatus.finishRun(err);
  }
});

// Skips TikTok/Instagram/Reddit collection entirely and goes straight to
// clustering -> Google Trends -> scoring -> recommendations, for resuming
// after a Claude-side failure (rate limit, etc.) without waiting through
// another full collection pass when there's already plenty of uncollected
// evidence sitting in the database.
admin.post('/rerun/cluster-only', async (req, res) => {
  if (runStatus.getStatus().running) {
    return res.status(409).json({ error: 'already_running', message: 'A collection run is already in progress.' });
  }
  res.json({ ok: true, message: 'Clustering-only run started.' });
  runStatus.startRun();
  await writeAudit(req, 'manual_cluster_only_triggered', 'ingest', null, null, null);
  try {
    await runPipeline({ skipCollection: true });
    runStatus.finishRun();
  } catch (err) {
    console.error('[rerun] failed:', err.message);
    runStatus.finishRun(err);
  }
});

app.use('/api/admin', admin);

const port = process.env.PORT || 3000;

// Bind the port immediately -- Render's port scan and platform health check
// need something to find right away, independent of how long Postgres
// takes to become reachable (see the dbReady guard above).
app.listen(port, () => console.log(`Sportsgirl Beauty Radar listening on port ${port} (database initializing...)`));

initSchemaForever()
  .then(() => seedConfig())
  .then(() => {
    dbReady = true;
    console.log('Database ready -- serving live data.');
  })
  .catch((err) => {
    // initSchemaForever never rejects; this only fires if seedConfig itself
    // throws after a successful connection (e.g. a genuine schema bug) --
    // that's worth crashing loudly on, unlike a slow-to-start database.
    console.error('Failed to seed config after schema init:', err);
    process.exit(1);
  });
