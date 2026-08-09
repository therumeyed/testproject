const { pool } = require('../db');

async function startSourceRun(platform, runType = 'scheduled') {
  const res = await pool.query(
    `INSERT INTO source_runs (platform, run_type, status) VALUES ($1, $2, 'running') RETURNING id`,
    [platform, runType]
  );
  return res.rows[0].id;
}

async function finishSourceRun(id, { status, itemsFetched, itemsNew, errorMessage }) {
  await pool.query(
    `UPDATE source_runs SET status = $2, items_fetched = $3, items_new = $4, error_message = $5, finished_at = now() WHERE id = $1`,
    [id, status, itemsFetched ?? null, itemsNew ?? null, errorMessage || null]
  );
}

// Skips any query already successfully collected today (no point re-spending
// Apify credit re-fetching the same keyword twice in one day), and caps how
// many get attempted this run -- prioritising whichever haven't succeeded
// most recently (NULLS FIRST puts queries that have never once succeeded at
// the front), so repeated runs rotate through the full seed list over time
// instead of always hammering the same handful and exhausting API tokens
// trying to cover everything in a single run.
async function getActiveQueries(platform, { maxResults } = {}) {
  const res = await pool.query(
    `SELECT id, platform, query_type, query_text, category_hint, last_success_at FROM discovery_queries
     WHERE platform = $1 AND active = true AND status = 'approved'
       AND (last_success_at IS NULL OR last_success_at::date < CURRENT_DATE)
     ORDER BY last_success_at ASC NULLS FIRST, id
     ${maxResults ? 'LIMIT $2' : ''}`,
    maxResults ? [platform, maxResults] : [platform]
  );
  return res.rows;
}

async function countSkippableQueries(platform) {
  const res = await pool.query(
    `SELECT count(*)::int AS n FROM discovery_queries
     WHERE platform = $1 AND active = true AND status = 'approved'
       AND last_success_at IS NOT NULL AND last_success_at::date = CURRENT_DATE`,
    [platform]
  );
  return res.rows[0].n;
}

async function markQuerySuccess(discoveryQueryId) {
  await pool.query(`UPDATE discovery_queries SET last_success_at = now() WHERE id = $1`, [discoveryQueryId]);
}

async function getNegativeAndExcludeTerms() {
  const res = await pool.query(
    `SELECT term, term_type FROM taxonomy_terms WHERE active = true AND term_type IN ('exclude', 'negative_keyword')`
  );
  return res.rows;
}

// Cheap, deterministic pre-filter applied before evidence ever reaches
// Claude -- e.g. a viral "hair dryer" post never gets classified as
// relevant no matter how high its view count (section 3.4).
async function isExcludedText(text) {
  if (!text) return false;
  const terms = await getNegativeAndExcludeTerms();
  const lower = text.toLowerCase();
  return terms.some((t) => lower.includes(t.term.toLowerCase()));
}

async function upsertCreator(platform, { platformCreatorId, handle, displayName, followerCount, verified }) {
  if (!platformCreatorId) return null;
  const res = await pool.query(
    `INSERT INTO creators (platform, platform_creator_id, handle, display_name, follower_count, verified, last_seen_at)
     VALUES ($1,$2,$3,$4,$5,$6, now())
     ON CONFLICT (platform, platform_creator_id) DO UPDATE SET
       handle = COALESCE(EXCLUDED.handle, creators.handle),
       display_name = COALESCE(EXCLUDED.display_name, creators.display_name),
       follower_count = COALESCE(EXCLUDED.follower_count, creators.follower_count),
       verified = COALESCE(EXCLUDED.verified, creators.verified),
       last_seen_at = now()
     RETURNING id`,
    [platform, platformCreatorId, handle || null, displayName || null, followerCount ?? null, verified ?? null]
  );
  return res.rows[0].id;
}

async function upsertRawItem(platform, nativeId, sourceRunId, rawJson) {
  const res = await pool.query(
    `INSERT INTO raw_social_items (platform, native_id, source_run_id, raw_json)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (platform, native_id) DO UPDATE SET raw_json = $4, source_run_id = $3, scraped_at = now()
     RETURNING id`,
    [platform, nativeId, sourceRunId, JSON.stringify(rawJson)]
  );
  return res.rows[0].id;
}

// Returns { id, isNew }. isNew=false means the post already existed (e.g.
// returned again by a different keyword) -- caller must not double-count it
// as a "new post" for velocity purposes, but should still record the query
// match for auditability.
async function upsertPost(post) {
  const existing = await pool.query(
    `SELECT id FROM social_posts WHERE platform = $1 AND native_id = $2`,
    [post.platform, post.nativeId]
  );
  if (existing.rows.length > 0) {
    await pool.query(
      `UPDATE social_posts SET last_seen_at = now(), raw_social_item_id = COALESCE($2, raw_social_item_id) WHERE id = $1`,
      [existing.rows[0].id, post.rawSocialItemId || null]
    );
    return { id: existing.rows[0].id, isNew: false };
  }

  const res = await pool.query(
    `INSERT INTO social_posts (
       platform, native_id, raw_social_item_id, url, content_type, caption, transcript,
       hashtags, mentions, creator_id, publish_ts, thumbnail_url, sound_id, sound_name,
       effect_info, duration_seconds, is_slideshow, is_sponsored, is_pinned, location_country,
       first_seen_at, last_seen_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20, COALESCE($21, now()), COALESCE($21, now()))
     RETURNING id`,
    [
      post.platform, post.nativeId, post.rawSocialItemId || null, post.url || null,
      post.contentType || null, post.caption || null, post.transcript || null,
      post.hashtags || [], post.mentions || [], post.creatorId || null,
      post.publishTs || null, post.thumbnailUrl || null, post.soundId || null,
      post.soundName || null, post.effectInfo || null, post.durationSeconds ?? null,
      post.isSlideshow ?? null, post.isSponsored ?? null, post.isPinned ?? null,
      post.locationCountry || null, post.firstSeenAt || null
    ]
  );
  return { id: res.rows[0].id, isNew: true };
}

// Null means "not returned by the platform"; distinct from an actual zero.
async function upsertMetricSnapshot(postId, snapshotDate, metrics) {
  await pool.query(
    `INSERT INTO post_metric_snapshots (post_id, snapshot_date, play_count, like_count, comment_count, share_count, save_count)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (post_id, snapshot_date) DO UPDATE SET
       play_count = $3, like_count = $4, comment_count = $5, share_count = $6, save_count = $7, captured_at = now()`,
    [postId, snapshotDate, metrics.playCount ?? null, metrics.likeCount ?? null, metrics.commentCount ?? null, metrics.shareCount ?? null, metrics.saveCount ?? null]
  );
}

async function recordQueryMatch(postId, discoveryQueryId) {
  if (!discoveryQueryId) return;
  await pool.query(
    `INSERT INTO post_query_matches (post_id, discovery_query_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
    [postId, discoveryQueryId]
  );
}

async function upsertComment(comment) {
  const res = await pool.query(
    `INSERT INTO comments (platform, native_comment_id, post_id, subreddit, author, body, score, posted_ts, contains_question, contains_purchase_intent)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (platform, native_comment_id) DO NOTHING
     RETURNING id`,
    [
      comment.platform, comment.nativeCommentId, comment.postId || null, comment.subreddit || null,
      comment.author || null, comment.body || null, comment.score ?? null, comment.postedTs || null,
      comment.containsQuestion || false, comment.containsPurchaseIntent || false
    ]
  );
  return res.rows[0]?.id || null;
}

module.exports = {
  startSourceRun, finishSourceRun, getActiveQueries, countSkippableQueries, markQuerySuccess,
  getNegativeAndExcludeTerms, isExcludedText,
  upsertCreator, upsertRawItem, upsertPost, upsertMetricSnapshot, recordQueryMatch, upsertComment
};
