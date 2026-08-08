require('dotenv').config();
const { pool, initSchemaWithRetry, insertMentions, updateSentiment, markAlerted } = require('./db');
const { classifyMentions } = require('./sentiment');
const { sendEmail } = require('./email');
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

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function mentionRowHtml(m) {
  const title = escapeHtml(m.title || m.source);
  const snippet = escapeHtml((m.snippet || '').slice(0, 300));
  const reason = m.reason ? `<div style="color:#64748b;font-size:12px;margin-top:4px;">Why: ${escapeHtml(m.reason)}</div>` : '';
  const link = m.url ? `<a href="${m.url}">${title}</a>` : title;
  return `<div style="margin-bottom:16px;padding-bottom:16px;border-bottom:1px solid #e2e8f0;">
    <div style="font-size:11px;text-transform:uppercase;color:#64748b;">${escapeHtml(m.source)}${m.severity ? ` — ${escapeHtml(m.severity)} severity` : ''}</div>
    <div style="font-weight:600;">${link}</div>
    <div style="font-size:13px;color:#0f172a;">${snippet}</div>
    ${reason}
  </div>`;
}

async function sendUrgentAlert(urgentMentions) {
  if (urgentMentions.length === 0) return;
  const html = `<h2>Urgent: ${urgentMentions.length} high-severity negative mention${urgentMentions.length > 1 ? 's' : ''} found</h2>
    <p>Found in today's Melbourne Airport mentions run. Recommend reviewing and responding directly.</p>
    ${urgentMentions.map(mentionRowHtml).join('')}`;
  await sendEmail({ subject: `⚠️ ${urgentMentions.length} urgent negative mention(s) -- Melbourne Airport`, html });
  for (const m of urgentMentions) await markAlerted(m.id);
}

// Sent every run, not literally once/day -- when the cron runs multiple
// times a day, each run's digest covers only what that run found (already
// deduped against every prior run), not a rolled-up full-day summary.
async function sendDigest(negativeMentions) {
  const html = negativeMentions.length === 0
    ? `<h2>Melbourne Airport mentions -- check-in</h2><p>No negative mentions found in this check.</p>`
    : `<h2>Melbourne Airport mentions -- check-in</h2>
       <p>${negativeMentions.length} negative mention${negativeMentions.length > 1 ? 's' : ''} found in this check across all sources.</p>
       ${negativeMentions.map(mentionRowHtml).join('')}`;
  await sendEmail({ subject: `Negative mentions -- ${negativeMentions.length} found`, html });
}

// Rolling 24h window, run once a day by the Render cron job. Each source
// module dedupes new items against `mentions` via the (source, external_id)
// unique constraint, so nothing is ever re-inserted or backfilled -- only
// content posted since the last run, or seen in search results for the
// first time, ever lands in the table.
async function run() {
  await initSchemaWithRetry();
  const sinceDate = new Date(Date.now() - 24 * 60 * 60 * 1000);

  let total = 0;
  const allNew = [];
  for (const src of SOURCES) {
    const startedAt = new Date();
    try {
      const mentions = await src.fetch(sinceDate);
      const insertedRows = await insertMentions(mentions);
      total += insertedRows.length;
      allNew.push(...insertedRows);
      console.log(`[${src.name}] fetched=${mentions.length} new=${insertedRows.length}`);
      await pool.query(
        `INSERT INTO ingest_runs (source, started_at, finished_at, new_count) VALUES ($1,$2,now(),$3)`,
        [src.name, startedAt, insertedRows.length]
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

  try {
    const classifications = await classifyMentions(allNew);
    const byId = new Map(allNew.map((m) => [m.id, m]));
    const classified = [];
    for (const c of classifications) {
      await updateSentiment(c.id, c);
      const m = byId.get(c.id);
      if (m) classified.push({ ...m, ...c });
    }

    const negative = classified.filter((m) => m.sentiment === 'negative');
    const urgent = negative.filter((m) => m.severity === 'high');
    console.log(`Classified ${classified.length} mentions: ${negative.length} negative (${urgent.length} high severity).`);

    await sendUrgentAlert(urgent);
    await sendDigest(negative);
  } catch (err) {
    console.error('Classification/alerting failed:', err.message);
  }

  await pool.end();
}

run().catch((err) => {
  console.error('Fatal ingest error:', err);
  process.exit(1);
});
