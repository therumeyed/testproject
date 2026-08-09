require('dotenv').config();
const { pool, initSchemaWithRetry } = require('./db');
const { seedConfig } = require('./config/seedConfig');
const tiktok = require('./collectors/tiktok');
const instagram = require('./collectors/instagram');
const reddit = require('./collectors/reddit');
const googleTrends = require('./collectors/googleTrends');
const { runClustering } = require('./cluster');
const { computeAllDailyMetrics, computeAndStoreScores } = require('./scoring');
const { runRecommendations } = require('./recommend');

// Daily pipeline (section 5.1 / Phase 1):
//   1. collect raw evidence from TikTok, Instagram, Reddit
//   2. cluster new evidence into canonical trend topics (Claude)
//   3. validate against Google Trends, now that canonical topics exist
//   4. roll up deterministic daily metrics + scores (code only)
//   5. generate evidence-grounded social/buying recommendations (Claude)
async function run() {
  await initSchemaWithRetry();
  await seedConfig();

  const today = new Date().toISOString().slice(0, 10);
  const collectionResults = [];

  for (const collector of [tiktok, instagram, reddit]) {
    try {
      const result = await collector.collect();
      collectionResults.push(result);
      console.log(`[ingest] ${result.platform}: fetched=${result.fetched} new=${result.new} skipped=${result.skipped}`);
    } catch (err) {
      console.error(`[ingest] collector failed:`, err.message);
    }
  }

  try {
    await runClustering();
  } catch (err) {
    console.error('[ingest] clustering failed:', err.message);
  }

  try {
    await googleTrends.collectForActiveTrends();
  } catch (err) {
    console.error('[ingest] google trends failed:', err.message);
  }

  try {
    const n = await computeAllDailyMetrics(today);
    console.log(`[ingest] computed daily metrics for ${n} trend(s)`);
  } catch (err) {
    console.error('[ingest] daily metrics failed:', err.message);
  }

  try {
    const n = await computeAndStoreScores(today);
    console.log(`[ingest] scored ${n} trend(s)`);
  } catch (err) {
    console.error('[ingest] scoring failed:', err.message);
  }

  try {
    await runRecommendations();
  } catch (err) {
    console.error('[ingest] recommendations failed:', err.message);
  }

  console.log('[ingest] run complete.');
  await pool.end();
}

run().catch((err) => {
  console.error('Fatal ingest error:', err);
  process.exit(1);
});
