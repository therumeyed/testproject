const { pool } = require('./db');
const { callClaudeJson, isConfigured } = require('./lib/claude');
const { getNegativeAndExcludeTerms } = require('./lib/repo');
const runStatus = require('./lib/runStatus');

// Classifies ONE post per Claude call, not a batch of many. Batching (tried
// at 30, 15, 8, and still failing on fragments as small as 2) turned out to
// be the wrong shape for this problem entirely: asking Claude for one JSON
// document containing a variable, unpredictable number of nested trend
// objects means ANY single malformed/cut-off part breaks the WHOLE
// response, no matter how small the batch. A single post's classification
// is a small, fixed-shape response with nothing left to truncate. Real
// concurrency (below) makes up for doing more, smaller calls instead of
// fewer, bigger ones -- and this is genuinely simpler code too, since there's
// no batch left to split-and-retry.
// Note on rate limits: up to this many calls can already be in flight
// before the first failure sets the stop flag (there's no request
// cancellation, only "don't start the next one") -- so a rate-limit hit
// costs at most ~CONCURRENCY wasted calls, not the single call that'd be
// ideal, but nowhere near the old batch-splitting cascade that could burn
// through dozens per failure. Verified locally: 5 concurrent posts against
// a mocked always-429 response made 5 calls total, not 1 -- bounded, not
// eliminated.
const CONCURRENCY = Number(process.env.ANTHROPIC_CLUSTER_CONCURRENCY) || 12;
// How many unclustered posts to pull from the DB per outer round (run
// CONCURRENCY of them at a time).
const CHUNK_FETCH_SIZE = 300;
// Optional cheaper/faster model just for the matching pass -- categorising
// a post against a known trend list needs far less reasoning than writing
// social/buying copy, so this is a reasonable place to trade some judgment
// for speed/cost if you want to. Unset by default (uses the same model as
// everything else); set e.g. to a Haiku model id to opt in.
const CLUSTER_MODEL = process.env.ANTHROPIC_CLUSTER_MODEL || undefined;
// How many existing trends get sent as context per classification call --
// see the comment on fetchExistingTrends() for why this is capped now.
const EXISTING_TRENDS_CONTEXT_LIMIT = Number(process.env.ANTHROPIC_CLUSTER_TREND_CONTEXT_LIMIT) || 60;

const MIN_ALIAS_MATCH_LENGTH = 4; // avoid ultra-short aliases causing false-positive substring matches

const PARENT_CATEGORIES = ['beauty_tools_accessories', 'cosmetics', 'beauty_gift_packs'];
const BRAND_FITS = ['core', 'adjacent', 'content_only', 'out_of_scope'];

// One post in, one decision out: either it matches (an existing trend or a
// new one) or there's insufficient evidence to place it anywhere.
function validateClassification(parsed) {
  if (!parsed || typeof parsed !== 'object') return 'response must be a JSON object';
  if (typeof parsed.matched !== 'boolean') return 'missing boolean "matched"';
  if (parsed.matched === false) return null;
  if (parsed.existingTrendId != null) return typeof parsed.confidence === 'number' ? null : 'missing numeric confidence';
  if (!parsed.canonicalTrendName || typeof parsed.canonicalTrendName !== 'string') return 'matched=true but missing canonicalTrendName/existingTrendId';
  if (!PARENT_CATEGORIES.includes(parsed.parentCategory)) return `invalid parentCategory: ${parsed.parentCategory}`;
  if (!BRAND_FITS.includes(parsed.brandFit)) return `invalid brandFit: ${parsed.brandFit}`;
  if (typeof parsed.confidence !== 'number') return 'missing numeric confidence';
  return null;
}

async function fetchUnclusteredPosts(limit) {
  const res = await pool.query(
    `SELECT sp.id, sp.platform, sp.caption, sp.transcript, sp.hashtags, sp.publish_ts,
            pms.play_count, pms.like_count, pms.comment_count, pms.share_count
     FROM social_posts sp
     LEFT JOIN LATERAL (
       SELECT play_count, like_count, comment_count, share_count
       FROM post_metric_snapshots WHERE post_id = sp.id ORDER BY snapshot_date DESC LIMIT 1
     ) pms ON true
     WHERE sp.is_relevant IS NULL
       AND NOT EXISTS (SELECT 1 FROM trend_post_matches tpm WHERE tpm.post_id = sp.id)
     ORDER BY sp.id
     LIMIT $1`,
    [limit]
  );
  return res.rows;
}

async function countUnclusteredPosts() {
  const res = await pool.query(
    `SELECT count(*)::int AS n FROM social_posts sp
     WHERE sp.is_relevant IS NULL AND NOT EXISTS (SELECT 1 FROM trend_post_matches tpm WHERE tpm.post_id = sp.id)`
  );
  return res.rows[0]?.n || 0;
}

async function fetchTopComments(postIds) {
  if (postIds.length === 0) return new Map();
  const res = await pool.query(
    `SELECT post_id, body, contains_question, contains_purchase_intent
     FROM comments
     WHERE post_id = ANY($1::int[])
     ORDER BY (contains_purchase_intent::int + contains_question::int) DESC, score DESC NULLS LAST
     LIMIT 300`,
    [postIds]
  );
  const byPost = new Map();
  for (const row of res.rows) {
    if (!byPost.has(row.post_id)) byPost.set(row.post_id, []);
    const arr = byPost.get(row.post_id);
    if (arr.length < 4) arr.push(row.body);
  }
  return byPost;
}

// limit=null (used by the free alias pre-match below) means "all of them" --
// it costs nothing to check every trend/alias in plain code. limit=N (used
// before every Claude call) bounds token cost: with per-post classification
// now making many more, smaller calls than batching did, the existing-
// trends context gets re-sent on EVERY call instead of once per batch, so
// an uncapped list would make growing the trend catalog quietly more
// expensive per post over time. Most-recently-active first, since a new
// post is statistically far more likely to be about a currently-live trend
// than a long-dormant one -- and the alias pre-match already catches exact
// name/alias matches regardless of recency, so this only trades away
// coverage for the harder, non-literal matches against old, quiet trends.
async function fetchExistingTrends(limit = null) {
  const res = await pool.query(
    `SELECT id, name, definition, parent_category, subcategory, brand_fit, aliases FROM (
       SELECT t.id, t.name, t.definition, t.parent_category, t.subcategory, t.brand_fit, t.last_active_date,
              array_agg(DISTINCT a.alias_text) FILTER (WHERE a.alias_text IS NOT NULL) AS aliases
       FROM trend_topics t
       LEFT JOIN trend_aliases a ON a.trend_topic_id = t.id
       WHERE t.status = 'active'
       GROUP BY t.id
       ORDER BY t.last_active_date DESC NULLS LAST, t.id DESC
       ${limit ? 'LIMIT $1' : ''}
     ) ranked
     ORDER BY id`,
    limit ? [limit] : []
  );
  return res.rows;
}

// Deterministic, zero-cost pass that runs BEFORE any Claude call: most new
// posts about an already-known trend are obviously about it (the caption
// or a hashtag literally contains the trend's name or an alias), and don't
// need an LLM's judgment to place. Only posts that don't match anything
// known go on to the (slower, costlier) Claude classification pass below.
// Longest-term-first matching avoids a short, generic alias grabbing a
// post that actually matches a more specific one.
async function preMatchByAlias() {
  const trends = await fetchExistingTrends();
  if (trends.length === 0) return 0;

  const terms = [];
  for (const t of trends) {
    if (t.name) terms.push({ trendId: t.id, term: t.name.toLowerCase() });
    for (const alias of t.aliases || []) terms.push({ trendId: t.id, term: alias.toLowerCase() });
  }
  const usableTerms = terms.filter((t) => t.term.length >= MIN_ALIAS_MATCH_LENGTH);
  usableTerms.sort((a, b) => b.term.length - a.term.length);
  if (usableTerms.length === 0) return 0;

  const posts = await fetchUnclusteredPosts(5000);
  let matched = 0;

  for (const post of posts) {
    const haystack = `${post.caption || ''} ${post.transcript || ''} ${(post.hashtags || []).join(' ')}`.toLowerCase();
    if (!haystack.trim()) continue;
    const hit = usableTerms.find((t) => haystack.includes(t.term));
    if (!hit) continue;

    await pool.query(
      `INSERT INTO trend_post_matches (trend_topic_id, post_id, match_confidence) VALUES ($1,$2,0.6)
       ON CONFLICT (trend_topic_id, post_id) WHERE post_id IS NOT NULL DO NOTHING`,
      [hit.trendId, post.id]
    );
    await pool.query(`UPDATE social_posts SET is_relevant = true WHERE id = $1`, [post.id]);
    await pool.query(`UPDATE trend_topics SET last_active_date = CURRENT_DATE, updated_at = now() WHERE id = $1`, [hit.trendId]);
    matched++;
  }

  return matched;
}

function buildSystemPrompt(excludeTerms) {
  const exclusions = excludeTerms.map((t) => t.term).join(', ');
  return `You are the topic-classification engine for Sportsgirl Beauty Radar, a trend intelligence tool for Sportsgirl (an Australian fashion/accessories retailer).

SCOPE: Sportsgirl only sells three beauty parent categories: Beauty Tools and Accessories, Cosmetics, and Beauty Gift Packs -- all at an affordable, mass-market price point.

EXPLICITLY OUT OF SCOPE (never classify these as a trend, no matter how popular): ${exclusions}. Also out of scope: large/professional/salon equipment, expensive devices, medical/injectable/clinical treatments, generic skincare/bath/body/fragrance/haircare trends unrelated to the three categories, and unsafe/dangerous/counterfeit content.

YOUR JOB: decide which SPECIFIC, ACTIONABLE canonical trend topic (not a vague category -- "short square chrome press-on nails" not "nails") the given post belongs to. Match true synonyms describing the same behaviour to an existing trend; do NOT invent a near-duplicate of an existing trend over a wording difference, but do NOT force-fit a post into an existing trend if it's really describing a distinct colour/finish/product form that matters to buyers.

RULES:
- Only use evidence given to you. Never invent facts, statistics, or claims not present in the supplied post/comments.
- If the post doesn't have enough evidence to confidently place, return matched=false rather than guessing.
- Prefer matching an EXISTING canonical trend (given below) over creating a near-duplicate. Only propose a new trend if none of the existing ones fit.
- Classify brandFit honestly: "out_of_scope" for anything popular but irrelevant to Sportsgirl's actual range/audience (e.g. a viral hair dryer).
- Keep every text field terse -- definitions and names are short phrases, not sentences with extra commentary.
- Return ONLY one valid, COMPACT JSON object: no markdown code fences, no pretty-printing, no indentation or extra whitespace/newlines.`;
}

function buildSinglePostPrompt(post, comments, existingTrends) {
  const existingLines = existingTrends.length
    ? existingTrends.map((t) => `id=${t.id} "${t.name}" (${t.parent_category}${t.subcategory ? '/' + t.subcategory : ''}, brandFit=${t.brand_fit}) aliases: ${(t.aliases || []).join(', ')}`).join('\n')
    : 'none yet';

  return `EXISTING CANONICAL TRENDS (match to one of these where applicable):
${existingLines}

POST TO CLASSIFY:
platform=${post.platform}
caption: ${(post.caption || '').slice(0, 300)}
hashtags: ${(post.hashtags || []).join(', ')}
transcript: ${(post.transcript || '').slice(0, 300)}
metrics: plays=${post.play_count ?? 'null'} likes=${post.like_count ?? 'null'} comments=${post.comment_count ?? 'null'} shares=${post.share_count ?? 'null'}
sample comments: ${comments.length ? comments.map((c) => `"${(c || '').slice(0, 150)}"`).join(' | ') : 'none'}

Return ONLY this compact JSON object, one line, no other text:
{"matched": true, "existingTrendId": null, "canonicalTrendName": "string", "definition": "short phrase", "parentCategory": "beauty_tools_accessories | cosmetics | beauty_gift_packs", "subcategory": "string", "attributes": {"productType": [], "colour": [], "finish": [], "shape": [], "design": [], "format": [], "occasion": [], "aesthetic": []}, "aliases": [], "brandFit": "core | adjacent | content_only | out_of_scope", "socialUse": true, "buyingUse": true, "confidence": 0.0}

If matching an existing trend, set "existingTrendId" to its id and you may omit the other classification fields. If there's insufficient evidence to place this post anywhere, return exactly {"matched": false}.`;
}

// Conversation intelligence (themes/questions/purchase signals/barriers) is
// generated once per trend in recommend.js instead of here -- see that
// file's top comment.
async function upsertMatch(classification, postId, existingTrendsRef) {
  const isNewTrend = classification.existingTrendId == null;
  const status = classification.brandFit === 'out_of_scope' ? 'suppressed' : 'active';
  let trendId = classification.existingTrendId;

  if (isNewTrend) {
    const res = await pool.query(
      `INSERT INTO trend_topics (name, definition, parent_category, subcategory, attributes, brand_fit, social_use, buying_use, status, first_detected_date, last_active_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, CURRENT_DATE, CURRENT_DATE)
       RETURNING id`,
      [
        classification.canonicalTrendName, classification.definition || null, classification.parentCategory,
        classification.subcategory || null, JSON.stringify(classification.attributes || {}), classification.brandFit,
        classification.socialUse !== false, classification.buyingUse !== false, status
      ]
    );
    trendId = res.rows[0].id;
    // Shared across this round's concurrent workers so a post classified
    // moments later can match this brand-new trend instead of creating
    // another near-duplicate. Two posts deciding "this is new" at almost
    // the same moment, before either sees the other's insert, can still
    // create a genuine duplicate -- accepted trade-off of running
    // concurrently; Admin has a manual merge tool for exactly this.
    existingTrendsRef.push({
      id: trendId, name: classification.canonicalTrendName, parent_category: classification.parentCategory,
      subcategory: classification.subcategory, brand_fit: classification.brandFit, aliases: classification.aliases || []
    });
  } else {
    await pool.query(
      `UPDATE trend_topics SET last_active_date = CURRENT_DATE, updated_at = now() WHERE id = $1`,
      [trendId]
    );
  }

  for (const alias of classification.aliases || []) {
    await pool.query(
      `INSERT INTO trend_aliases (trend_topic_id, alias_text) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [trendId, alias]
    );
  }

  await pool.query(
    `INSERT INTO trend_post_matches (trend_topic_id, post_id, match_confidence) VALUES ($1,$2,$3)
     ON CONFLICT (trend_topic_id, post_id) WHERE post_id IS NOT NULL DO NOTHING`,
    [trendId, postId, classification.confidence ?? 0.7]
  );
  await pool.query(`UPDATE social_posts SET is_relevant = true WHERE id = $1`, [postId]);

  return trendId;
}

async function classifyPost(post, commentsByPost, existingTrendsRef, excludeTerms) {
  if (runStatus.isStopRequested()) return 0;

  const comments = commentsByPost.get(post.id) || [];
  let response;
  try {
    response = await callClaudeJson({
      system: buildSystemPrompt(excludeTerms),
      prompt: buildSinglePostPrompt(post, comments, existingTrendsRef),
      maxTokens: 2048, // a single classification decision is small -- generous headroom, not a guess made under pressure
      validate: validateClassification,
      model: CLUSTER_MODEL,
      // This is a structured classification decision, not creative writing --
      // at default temperature the model occasionally lands its very first
      // sampled token on a stop token, producing a genuine 0-char response
      // (stop_reason=end_turn, not max_tokens truncation). temperature: 0
      // makes the highest-probability token dominate, eliminating that.
      temperature: 0
    });
  } catch (err) {
    if (err.isRateLimit) {
      console.error('[cluster] Anthropic rate/usage limit hit -- stopping clustering for this run.');
      runStatus.pushLog(`Anthropic rate/usage limit hit -- stopping clustering (${err.message})`);
      runStatus.requestStop();
      return 0;
    }
    console.error(`[cluster] post ${post.id} failed after retries:`, err.message);
    runStatus.pushLog(`Post ${post.id} failed, leaving for next run: ${err.message}`);
    return 0;
  }

  if (!response.matched) {
    await pool.query(`UPDATE social_posts SET is_relevant = false WHERE id = $1`, [post.id]);
    return 0;
  }

  const trendId = await upsertMatch(response, post.id, existingTrendsRef);
  const trendName = response.existingTrendId
    ? existingTrendsRef.find((t) => t.id === trendId)?.name
    : response.canonicalTrendName;
  runStatus.pushLog(`Post ${post.id} -> "${trendName || 'trend #' + trendId}"`);
  return 1;
}

// Runs `worker` over `items` with at most `limit` in flight at once.
async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function runNext() {
    while (next < items.length) {
      if (runStatus.isStopRequested()) return;
      const i = next++;
      results[i] = await worker(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runNext));
  return results;
}

async function runClustering() {
  if (!isConfigured()) {
    console.log('[cluster] skipped: ANTHROPIC_API_KEY not set');
    return { clustered: 0, skipped: true };
  }

  const preMatched = await preMatchByAlias();
  if (preMatched > 0) {
    console.log(`[cluster] alias pre-match assigned ${preMatched} post(s) without using Claude`);
    runStatus.pushLog(`Alias pre-match: assigned ${preMatched} post(s) to existing trends without using Claude`);
  }

  const remaining = await countUnclusteredPosts();
  runStatus.setStage('clustering', remaining);

  let totalClustered = 0;
  let posts = await fetchUnclusteredPosts(CHUNK_FETCH_SIZE);

  while (posts.length > 0) {
    if (runStatus.isStopRequested()) { runStatus.pushLog('Clustering: stopping.'); break; }

    const commentsByPost = await fetchTopComments(posts.map((p) => p.id));
    const excludeTerms = await getNegativeAndExcludeTerms();
    const existingTrendsRef = await fetchExistingTrends(EXISTING_TRENDS_CONTEXT_LIMIT); // shared + mutable across this round's concurrent workers

    const results = await runWithConcurrency(posts, CONCURRENCY, async (post) => {
      const n = await classifyPost(post, commentsByPost, existingTrendsRef, excludeTerms);
      runStatus.tick((post.caption || `post ${post.id}`).slice(0, 60));
      return n;
    });
    totalClustered += results.reduce((a, b) => a + (b || 0), 0);

    if (runStatus.isStopRequested()) break;
    posts = await fetchUnclusteredPosts(CHUNK_FETCH_SIZE);
  }

  const grandTotal = totalClustered + preMatched;
  console.log(`[cluster] clustered ${grandTotal} posts into trends (${preMatched} via alias match, ${totalClustered} via Claude)`);
  runStatus.pushLog(`Clustering done: ${grandTotal} post(s) clustered (${preMatched} via alias match, ${totalClustered} via Claude)`);
  return { clustered: grandTotal, skipped: false };
}

module.exports = { runClustering };
