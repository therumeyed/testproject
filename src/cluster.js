const { pool } = require('./db');
const { callClaudeJson, isConfigured } = require('./lib/claude');
const { getNegativeAndExcludeTerms } = require('./lib/repo');
const runStatus = require('./lib/runStatus');

// Bigger than the old value now that the per-cluster schema is much
// leaner (no conversation-intelligence fields -- see note below), so a
// batch's response stays well within budget even with more posts in it.
const BATCH_SIZE = 30;
// How many Claude calls run at once. This is the single biggest lever on
// wall-clock time -- clustering was strictly sequential before (one call,
// wait, next call), which is the main reason it took ages on a large
// backlog. Tune via ANTHROPIC_CLUSTER_CONCURRENCY if needed.
const CONCURRENCY = Number(process.env.ANTHROPIC_CLUSTER_CONCURRENCY) || 4;
// How many unclustered posts to pull from the DB per outer round (split
// into BATCH_SIZE-sized chunks and run CONCURRENCY at a time).
const CHUNK_FETCH_SIZE = 300;
// Optional cheaper/faster model just for the matching pass -- categorising
// a post against a known trend list needs far less reasoning than writing
// social/buying copy, so this is a reasonable place to trade some judgment
// for speed/cost if you want to. Unset by default (uses the same model as
// everything else); set e.g. to a Haiku model id to opt in.
const CLUSTER_MODEL = process.env.ANTHROPIC_CLUSTER_MODEL || undefined;

const MIN_ALIAS_MATCH_LENGTH = 4; // avoid ultra-short aliases causing false-positive substring matches

const PARENT_CATEGORIES = ['beauty_tools_accessories', 'cosmetics', 'beauty_gift_packs'];
const BRAND_FITS = ['core', 'adjacent', 'content_only', 'out_of_scope'];

// Required output schema per requirements section 13, extended with
// existingTrendId (lets Claude attach evidence to an already-canonical
// trend instead of minting a near-duplicate) and confidence retained from
// the spec's own schema. Conversation-intelligence fields (themes,
// questions, purchase signals, barriers) are deliberately NOT requested
// here anymore -- see the comment above upsertCluster().
function validateClusterResponse(parsed) {
  if (!parsed || typeof parsed !== 'object') return 'response must be a JSON object';
  if (!Array.isArray(parsed.clusters)) return 'missing "clusters" array';
  if (!Array.isArray(parsed.unclusteredPostIds)) return 'missing "unclusteredPostIds" array';
  for (const c of parsed.clusters) {
    if (!c.canonicalTrendName || typeof c.canonicalTrendName !== 'string') return 'cluster missing canonicalTrendName';
    if (!PARENT_CATEGORIES.includes(c.parentCategory)) return `cluster has invalid parentCategory: ${c.parentCategory}`;
    if (!BRAND_FITS.includes(c.brandFit)) return `cluster has invalid brandFit: ${c.brandFit}`;
    if (!Array.isArray(c.evidencePostIds) || c.evidencePostIds.length === 0) return 'cluster missing evidencePostIds';
    if (typeof c.confidence !== 'number') return 'cluster missing numeric confidence';
  }
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

async function fetchExistingTrends() {
  const res = await pool.query(
    `SELECT t.id, t.name, t.definition, t.parent_category, t.subcategory, t.brand_fit,
            array_agg(DISTINCT a.alias_text) FILTER (WHERE a.alias_text IS NOT NULL) AS aliases
     FROM trend_topics t
     LEFT JOIN trend_aliases a ON a.trend_topic_id = t.id
     WHERE t.status = 'active'
     GROUP BY t.id
     ORDER BY t.id`
  );
  return res.rows;
}

// Deterministic, zero-cost pass that runs BEFORE any Claude call: most new
// posts about an already-known trend are obviously about it (the caption
// or a hashtag literally contains the trend's name or an alias), and don't
// need an LLM's judgment to place. Only posts that don't match anything
// known go on to the (slower, costlier) Claude clustering pass below.
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
  return `You are the topic-clustering engine for Sportsgirl Beauty Radar, a trend intelligence tool for Sportsgirl (an Australian fashion/accessories retailer).

SCOPE: Sportsgirl only sells three beauty parent categories: Beauty Tools and Accessories, Cosmetics, and Beauty Gift Packs -- all at an affordable, mass-market price point.

EXPLICITLY OUT OF SCOPE (never cluster these as a trend, no matter how popular): ${exclusions}. Also out of scope: large/professional/salon equipment, expensive devices, medical/injectable/clinical treatments, generic skincare/bath/body/fragrance/haircare trends unrelated to the three categories, and unsafe/dangerous/counterfeit content.

YOUR JOB: group the given posts into SPECIFIC, ACTIONABLE canonical trend topics (not vague categories -- "short square chrome press-on nails" not "nails"). Merge true synonyms describing the same behaviour; do NOT merge distinct colours/finishes/product forms that matter to buyers, and do NOT split the same idea into minor wording variants.

RULES:
- Only use evidence given to you. Never invent facts, statistics, or claims not present in the supplied posts/comments.
- If a post doesn't have enough evidence to confidently place in a specific trend, leave it out of every cluster and list its id in "unclusteredPostIds" instead of guessing.
- If a cluster of posts matches an EXISTING canonical trend (given below), set "existingTrendId" to that trend's id instead of creating a near-duplicate. Only create a new trend if none of the existing ones fit.
- Classify brandFit honestly: "out_of_scope" for anything popular but irrelevant to Sportsgirl's actual range/audience (e.g. a viral hair dryer).
- Return ONLY valid JSON, no other text.`;
}

function buildUserPrompt(posts, commentsByPost, existingTrends) {
  const postLines = posts.map((p) => {
    const comments = commentsByPost.get(p.id) || [];
    return `POST id=${p.id} platform=${p.platform}
caption: ${(p.caption || '').slice(0, 300)}
hashtags: ${(p.hashtags || []).join(', ')}
transcript: ${(p.transcript || '').slice(0, 300)}
metrics: plays=${p.play_count ?? 'null'} likes=${p.like_count ?? 'null'} comments=${p.comment_count ?? 'null'} shares=${p.share_count ?? 'null'}
sample comments: ${comments.length ? comments.map((c) => `"${(c || '').slice(0, 150)}"`).join(' | ') : 'none'}`;
  }).join('\n\n');

  const existingLines = existingTrends.length
    ? existingTrends.map((t) => `id=${t.id} "${t.name}" (${t.parent_category}${t.subcategory ? '/' + t.subcategory : ''}, brandFit=${t.brand_fit}) aliases: ${(t.aliases || []).join(', ')}`).join('\n')
    : 'none yet';

  return `EXISTING CANONICAL TRENDS (match to these where applicable):
${existingLines}

POSTS TO CLUSTER:
${postLines}

Return a JSON object exactly matching this shape:
{
  "clusters": [
    {
      "existingTrendId": null,
      "canonicalTrendName": "string",
      "definition": "one sentence, plain language",
      "parentCategory": "beauty_tools_accessories | cosmetics | beauty_gift_packs",
      "subcategory": "string",
      "attributes": { "productType": [], "colour": [], "finish": [], "shape": [], "design": [], "format": [], "occasion": [], "aesthetic": [] },
      "aliases": [],
      "brandFit": "core | adjacent | content_only | out_of_scope",
      "socialUse": true,
      "buyingUse": true,
      "evidencePostIds": [/* post ids from above, integers */],
      "confidence": 0.0
    }
  ],
  "unclusteredPostIds": [/* post ids with insufficient evidence to place anywhere */]
}`;
}

// Conversation intelligence (themes/questions/purchase signals/barriers) is
// no longer generated here. It used to be requested on every single
// clustering batch call, which meant it was redundantly regenerated many
// times over for the same trend as new evidence trickled in across
// batches -- wasted spend for no real benefit. It's now generated once per
// trend per run, grounded in that trend's full evidence, as part of
// recommend.js's existing per-trend call instead.
async function upsertCluster(cluster) {
  const isNewTrend = !cluster.existingTrendId;
  const status = cluster.brandFit === 'out_of_scope' ? 'suppressed' : 'active';
  let trendId = cluster.existingTrendId;

  if (isNewTrend) {
    const res = await pool.query(
      `INSERT INTO trend_topics (name, definition, parent_category, subcategory, attributes, brand_fit, social_use, buying_use, status, first_detected_date, last_active_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, CURRENT_DATE, CURRENT_DATE)
       RETURNING id`,
      [
        cluster.canonicalTrendName, cluster.definition || null, cluster.parentCategory,
        cluster.subcategory || null, JSON.stringify(cluster.attributes || {}), cluster.brandFit,
        cluster.socialUse !== false, cluster.buyingUse !== false, status
      ]
    );
    trendId = res.rows[0].id;
  } else {
    await pool.query(
      `UPDATE trend_topics SET last_active_date = CURRENT_DATE, updated_at = now() WHERE id = $1`,
      [trendId]
    );
  }

  for (const alias of cluster.aliases || []) {
    await pool.query(
      `INSERT INTO trend_aliases (trend_topic_id, alias_text) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [trendId, alias]
    );
  }

  for (const postId of cluster.evidencePostIds || []) {
    await pool.query(
      `INSERT INTO trend_post_matches (trend_topic_id, post_id, match_confidence) VALUES ($1,$2,$3)
       ON CONFLICT (trend_topic_id, post_id) WHERE post_id IS NOT NULL DO NOTHING`,
      [trendId, postId, cluster.confidence]
    );
    await pool.query(`UPDATE social_posts SET is_relevant = true WHERE id = $1`, [postId]);
  }

  return trendId;
}

// Attempts to cluster a batch of posts; if Claude's response gets truncated
// (whatever the batch size, some content mixes just need more output than
// others -- a fixed batch size is always going to be wrong for some batch)
// it splits the batch in half and retries each half, recursively, instead
// of abandoning the whole batch. Bottoms out at a single post: if that
// still fails, only that one post is left unclustered for a future run.
async function clusterSubBatch(subBatch, commentsByPost, excludeTerms) {
  // A prior sibling call (or the Stop button) may have already triggered a
  // stop -- don't fire off another Claude call once that's happened.
  if (runStatus.isStopRequested()) return 0;

  const existingTrends = await fetchExistingTrends(); // refetch so later splits/batches see trends created by earlier ones
  let response;
  try {
    response = await callClaudeJson({
      system: buildSystemPrompt(excludeTerms),
      prompt: buildUserPrompt(subBatch, commentsByPost, existingTrends),
      // What actually drives response size is how many DISTINCT trends a
      // batch maps to, not the schema weight -- a batch of 30 genuinely
      // novel posts can still produce 15-20 separate cluster objects, and
      // that blows past a smaller cap regardless of how lean each one is.
      // Learned this the hard way by lowering it after the last schema
      // simplification; putting the headroom back.
      maxTokens: 8192,
      validate: validateClusterResponse,
      model: CLUSTER_MODEL
    });
  } catch (err) {
    if (err.isRateLimit) {
      // Splitting and retrying here would just fan out into many more
      // requests against an already-exhausted rate/usage limit, making it
      // worse. Stop the whole run cleanly instead -- whatever's left over
      // just picks up next time once the limit has recovered.
      console.error('[cluster] Anthropic rate/usage limit hit -- stopping clustering for this run.');
      runStatus.pushLog(`Anthropic rate/usage limit hit -- stopping clustering (${err.message})`);
      runStatus.requestStop();
      return 0;
    }
    if (subBatch.length > 1) {
      const mid = Math.ceil(subBatch.length / 2);
      runStatus.pushLog(`Clustering batch of ${subBatch.length} failed (${err.message}) -- splitting into ${mid} + ${subBatch.length - mid} and retrying`);
      const a = await clusterSubBatch(subBatch.slice(0, mid), commentsByPost, excludeTerms);
      if (runStatus.isStopRequested()) return a;
      const b = await clusterSubBatch(subBatch.slice(mid), commentsByPost, excludeTerms);
      return a + b;
    }
    console.error(`[cluster] post ${subBatch[0]?.id} failed after retries:`, err.message);
    runStatus.pushLog(`Clustering post ${subBatch[0]?.id} failed, leaving for next run: ${err.message}`);
    return 0;
  }

  let clusteredCount = 0;
  for (const cluster of response.clusters) {
    await upsertCluster(cluster);
    clusteredCount += cluster.evidencePostIds.length;
    runStatus.pushLog(`Clustered "${cluster.canonicalTrendName}" (${cluster.evidencePostIds.length} post(s))`);
  }

  const clusteredIds = new Set(response.clusters.flatMap((c) => c.evidencePostIds));
  const leftoverIds = subBatch.map((p) => p.id).filter((id) => !clusteredIds.has(id));
  if (leftoverIds.length > 0) {
    await pool.query(`UPDATE social_posts SET is_relevant = false WHERE id = ANY($1::int[])`, [leftoverIds]);
  }

  return clusteredCount;
}

// Runs `worker` over `items` with at most `limit` in flight at once --
// clustering used to process one batch at a time, waiting for each Claude
// call to finish before starting the next, which was the single biggest
// contributor to it "taking ages" on a large backlog.
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

    const batches = [];
    for (let i = 0; i < posts.length; i += BATCH_SIZE) batches.push(posts.slice(i, i + BATCH_SIZE));

    const results = await runWithConcurrency(batches, CONCURRENCY, async (batch) => {
      const n = await clusterSubBatch(batch, commentsByPost, excludeTerms);
      runStatus.tick(`processed ${batch.length} post(s)`, batch.length);
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
