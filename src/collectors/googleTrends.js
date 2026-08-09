const { runActor } = require('../lib/apifyClient');
const { pool } = require('../db');
const repo = require('../lib/repo');

// Field mapping is a best-effort shape for Google Trends scraper Actors on
// Apify (e.g. emastra/google-trends-scraper); RECONFIRM against a live
// sample run before production (README "Phase 0") -- Google Trends has no
// official free API, and community actor output shapes vary more than
// platform scrapers do.
const ACTOR_ID = process.env.APIFY_GOOGLE_TRENDS_ACTOR_ID || 'emastra/google-trends-scraper';

// Unlike the platform collectors (which search by seed keyword), Google
// Trends validation runs per CANONICAL TREND, using the trend name and its
// approved aliases as search terms -- so this only has something to search
// once clustering (cluster.js) has produced trend_topics. Called after
// clustering in ingest.js.
async function collectForActiveTrends() {
  if (!process.env.APIFY_TOKEN) {
    console.log('[google_trends] skipped: APIFY_TOKEN not set');
    return { platform: 'google_trends', skipped: true, fetched: 0, new: 0 };
  }

  const runId = await repo.startSourceRun('google_trends');
  const { rows: trends } = await pool.query(
    `SELECT id, name FROM trend_topics WHERE status = 'active' ORDER BY id`
  );

  let fetched = 0;
  const today = new Date().toISOString().slice(0, 10);

  try {
    for (const trend of trends) {
      for (const country of ['', 'AU']) {
        let items;
        try {
          items = await runActor(ACTOR_ID, {
            searchTerms: [trend.name],
            geo: country,
            timeRange: 'today 3-m'
          });
        } catch (err) {
          console.error(`[google_trends] "${trend.name}" (${country || 'GLOBAL'}) failed:`, err.message);
          continue;
        }

        const countryLabel = country || 'GLOBAL';
        for (const item of items || []) {
          const seriesDate = (item.date || item.time || today).slice(0, 10);
          const value = item.value ?? item.interest ?? item.formattedValue ?? null;
          if (value === null) continue;
          fetched++;
          await pool.query(
            `INSERT INTO google_trends_series (trend_topic_id, country, search_term, series_date, interest_index, is_breakout)
             VALUES ($1,$2,$3,$4,$5,$6)
             ON CONFLICT (trend_topic_id, country, search_term, series_date) DO UPDATE SET interest_index = $5`,
            [trend.id, countryLabel, trend.name, seriesDate, Number(value), Boolean(item.isBreakout)]
          );
        }

        for (const rq of items?.[0]?.relatedQueries || []) {
          await pool.query(
            `INSERT INTO trend_related_queries (trend_topic_id, country, query_text, rising_value, series_date)
             VALUES ($1,$2,$3,$4,$5)`,
            [trend.id, countryLabel, rq.query || rq.term, rq.value || rq.formattedValue || null, today]
          );
        }
      }
    }

    await repo.finishSourceRun(runId, { status: 'success', itemsFetched: fetched, itemsNew: fetched });
  } catch (err) {
    await repo.finishSourceRun(runId, { status: 'error', itemsFetched: fetched, errorMessage: err.message });
    throw err;
  }

  return { platform: 'google_trends', skipped: false, fetched, new: fetched };
}

module.exports = { collectForActiveTrends };
