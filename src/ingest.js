require('dotenv').config();
const { pool, initSchemaWithRetry, insertMentions } = require('./db');
const reddit = require('./sources/reddit');
const youtube = require('./sources/youtube');
const serp = require('./sources/serpSearch');
const facebookSearch = require('./sources/facebookSearch');
const instagramSearch = require('./sources/instagramSearch');
const facebookOwned = require('./sources/facebookOwned');
const instagramOwned = require('./sources/instagramOwned');
const googleReviews = require('./sources/googleReviews');

const SOURCES = [
  { name: 'reddit', fetch: reddit.fetchMentions },
  { name: 'youtube', fetch: youtube.fetchMentions },
  { name: 'serp', fetch: serp.fetchMentions },
  { name: 'facebook_direct', fetch: facebookSearch.fetchMentions },
  { name: 'instagram_direct', fetch: instagramSearch.fetchMentions },
  { name: 'google_reviews', fetch: googleReviews.fetchMentions },
  { name: 'facebook_own', fetch: facebookOwned.fetchMentions },
  { name: 'instagram_own', fetch: instagramOwned.fetchMentions }
];

// Rolling 24h window, run once a day by the Render cron job. Each source
// module dedupes new items against `mentions` via the (source, external_id)
// unique constraint, so nothing is ever re-inserted or backfilled -- only
// content posted since the last run, or seen in search results for the
// first time, ever lands in the table.
async function run() {
  await initSchemaWithRetry();
  const sinceDate = new Date(Date.now() - 24 * 60 * 60 * 1000);

  let total = 0;
  for (const src of SOURCES) {
    const startedAt = new Date();
    try {
      const mentions = await src.fetch(sinceDate);
      const inserted = await insertMentions(mentions);
      total += inserted;
      console.log(`[${src.name}] fetched=${mentions.length} new=${inserted}`);
      await pool.query(
        `INSERT INTO ingest_runs (source, started_at, finished_at, new_count) VALUES ($1,$2,now(),$3)`,
        [src.name, startedAt, inserted]
      );
    } catch (err) {
      console.error(`[${src.name}] failed:`, err.message);
      await pool.query(
        `INSERT INTO ingest_runs (source, started_at, finished_at, error) VALUES ($1,$2,now(),$3)`,
        [src.name, startedAt, err.message]
      );
    }
  }

  console.log(`Ingest complete. ${total} new mentions.`);
  await pool.end();
}

run().catch((err) => {
  console.error('Fatal ingest error:', err);
  process.exit(1);
});
