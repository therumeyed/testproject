const { pool } = require('./db');
const { callClaudeJson, isConfigured } = require('./lib/claude');
const { getNegativeAndExcludeTerms } = require('./lib/repo');
const runStatus = require('./lib/runStatus');

// Smaller than it looks: each post in a batch carries caption/hashtags/
// transcript/comments/metrics, and each resulting cluster in the response
// carries a full schema (attributes, aliases, conversation themes, etc.) --
// 25 posts could produce a response that got silently truncated at the old
// 4096-token cap, which broke JSON.parse ("Unexpected end of JSON input")
// and skipped clustering for the whole batch. Smaller batch + higher cap
// below gives real headroom.
const BATCH_SIZE = 15;
const PARENT_CATEGORIES = ['beauty_tools_accessories', 'cosmetics', 'beauty_gift_packs'];
const BRAND_FITS = ['core', 'adjacent', 'content_only', 'out_of_scope'];

// Required output schema per requirements section 13, extended with
// existingTrendId (lets Claude attach evidence to an already-canonical
// trend instead of minting a near-duplicate) and confidence retained from
// the spec's own schema.
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
      "conversationThemes": [],
      "questions": [],
      "purchaseSignals": [],
      "barriers": [],
      "evidencePostIds": [/* post ids from above, integers */],
      "confidence": 0.0
    }
  ],
  "unclusteredPostIds": [/* post ids with insufficient evidence to place anywhere */]
}`;
}

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

  await pool.query(
    `INSERT INTO trend_recommendations (trend_topic_id, rec_type, payload)
     VALUES ($1, 'conversation_summary', $2)`,
    [trendId, JSON.stringify({
      conversationThemes: cluster.conversationThemes || [],
      questions: cluster.questions || [],
      purchaseSignals: cluster.purchaseSignals || [],
      barriers: cluster.barriers || [],
      confidence: cluster.confidence
    })]
  );

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

  const existingTrends = await fetchExistingTrends(); // refetch so later splits see trends created by earlier ones
  let response;
  try {
    response = await callClaudeJson({
      system: buildSystemPrompt(excludeTerms),
      prompt: buildUserPrompt(subBatch, commentsByPost, existingTrends),
      maxTokens: 8192,
      validate: validateClusterResponse
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

async function runClustering() {
  if (!isConfigured()) {
    console.log('[cluster] skipped: ANTHROPIC_API_KEY not set');
    return { clustered: 0, skipped: true };
  }

  const { rows: countRows } = await pool.query(
    `SELECT count(*)::int AS n FROM social_posts sp
     WHERE sp.is_relevant IS NULL AND NOT EXISTS (SELECT 1 FROM trend_post_matches tpm WHERE tpm.post_id = sp.id)`
  );
  runStatus.setStage('clustering', countRows[0]?.n || 0);

  let totalClustered = 0;
  let batch = await fetchUnclusteredPosts(BATCH_SIZE);

  while (batch.length > 0) {
    if (runStatus.isStopRequested()) { runStatus.pushLog('Clustering: stopping.'); break; }
    const commentsByPost = await fetchTopComments(batch.map((p) => p.id));
    const excludeTerms = await getNegativeAndExcludeTerms();

    totalClustered += await clusterSubBatch(batch, commentsByPost, excludeTerms);
    runStatus.tick(`processed ${batch.length} post(s)`, batch.length);

    batch = await fetchUnclusteredPosts(BATCH_SIZE);
  }

  console.log(`[cluster] clustered ${totalClustered} posts into trends`);
  runStatus.pushLog(`Clustering done: ${totalClustered} post(s) clustered`);
  return { clustered: totalClustered, skipped: false };
}

module.exports = { runClustering };
