const { pool } = require('./db');
const { callClaudeJson, isConfigured } = require('./lib/claude');
const { getNegativeAndExcludeTerms } = require('./lib/repo');
const runStatus = require('./lib/runStatus');

// Sampling-based clustering (replaces the old per-post Claude classifier).
// Instead of asking Claude to judge every single unclustered post (thousands
// of calls per run, the dominant Anthropic cost), this counts word-phrase
// frequency across ALL unclustered posts in plain code (free), takes the
// TOP_PHRASE_COUNT most-repeated phrases, and only spends a Claude call on
// those -- one call per phrase, turning a frequent phrase into a clean trend
// name/definition/category, grounded in a sample of the posts that used it.
// A post whose phrase doesn't make the top list just stays unclustered for
// a future run rather than being force-classified -- this only ever surfaces
// the strongest, most-repeated signals, by design (see also the per-run
// query caps on the collectors, same philosophy).
const TOP_PHRASE_COUNT = Number(process.env.CLUSTER_TOP_PHRASE_COUNT) || 15;
// A phrase needs to show up in at least this many DISTINCT posts to be a
// candidate at all -- filters out one-off wording that isn't actually a
// repeating pattern.
const MIN_PHRASE_POST_COUNT = Number(process.env.CLUSTER_MIN_PHRASE_POSTS) || 3;
// How many of a phrase's (highest-engagement) posts get sent to Claude as
// grounding evidence -- the phrase's Claude call doesn't need every post
// that used it, just enough to judge whether it's a real, specific trend.
const SAMPLE_POSTS_PER_PHRASE = 6;
// Safety cap on how many unclustered posts get pulled into memory for
// frequency counting in one run -- this is plain in-process counting, not a
// Claude call, so it's cheap; the cap just bounds one run's DB fetch size.
const SAMPLE_POST_LIMIT = Number(process.env.CLUSTER_SAMPLE_POST_LIMIT) || 20000;
// Only 15ish Claude calls happen per run now (vs. thousands before), so
// Haiku is more than enough -- override via env if match quality suffers.
const CLUSTER_MODEL = process.env.ANTHROPIC_CLUSTER_MODEL || 'claude-haiku-4-5-20251001';

const MIN_ALIAS_MATCH_LENGTH = 4; // avoid ultra-short aliases causing false-positive substring matches

const PARENT_CATEGORIES = ['beauty_tools_accessories', 'cosmetics', 'beauty_gift_packs'];
const BRAND_FITS = ['core', 'adjacent', 'content_only', 'out_of_scope'];

// Common English filler words that shouldn't anchor the start/end of a
// candidate phrase (interior stopwords are fine -- "press on nails" is a
// real phrase even though "on" is one).
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'for', 'with', 'is', 'are', 'was', 'were',
  'be', 'been', 'it', 'its', 'this', 'that', 'these', 'those', 'i', 'you', 'he', 'she', 'we', 'they',
  'my', 'your', 'our', 'their', 'me', 'him', 'her', 'us', 'them', 'so', 'if', 'at', 'by', 'as', 'from',
  'not', 'no', 'yes', 'do', 'does', 'did', 'just', 'can', 'will', 'would', 'should', 'could', 'have',
  'has', 'had', 'get', 'got', 'like', 'im', 'ive', 'dont', 'didnt', 'cant', 'youre', 'all', 'out', 'up',
  'down', 'over', 'under', 'again', 'more', 'most', 'some', 'such', 'than', 'too', 'very', 'via', 'into',
  'when', 'what', 'who', 'how', 'why', 'now', 'here', 'there', 'about', 'new'
]);

// One phrase in, one decision out: either it names an existing trend, a new
// one, or there isn't enough evidence/it's out of scope.
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

// limit=null means "all of them" -- it costs nothing to check every trend/
// alias in plain code (preMatchByAlias) or send them all to one of the
// handful of phrase-classification calls per run (runClustering) now that
// call volume is small.
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
// known are candidates for the phrase-sampling pass below. Longest-term-
// first matching avoids a short, generic alias grabbing a post that
// actually matches a more specific one.
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

  const posts = await fetchUnclusteredPosts(SAMPLE_POST_LIMIT);
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

function tokenize(text) {
  return (text || '')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^a-z0-9\s#]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

// A post's candidate phrases: 2-3 word contiguous n-grams from its caption/
// transcript (excluding ones that start or end on a filler word), plus its
// hashtags treated as phrases in their own right. Deduped per post so one
// post repeating a phrase several times only counts once towards that
// phrase's distinct-post total.
function extractPhrasesForPost(post) {
  const phrases = new Set();
  const tokens = tokenize(`${post.caption || ''} ${post.transcript || ''}`).filter((t) => !t.startsWith('#'));

  for (let n = 2; n <= 3; n++) {
    for (let i = 0; i + n <= tokens.length; i++) {
      const gram = tokens.slice(i, i + n);
      if (STOPWORDS.has(gram[0]) || STOPWORDS.has(gram[gram.length - 1])) continue;
      if (gram.some((w) => w.length < 2)) continue;
      phrases.add(gram.join(' '));
    }
  }

  for (const h of post.hashtags || []) {
    const clean = String(h || '').toLowerCase().replace(/^#/, '').trim();
    if (clean.length >= MIN_ALIAS_MATCH_LENGTH) phrases.add(clean);
  }

  return phrases;
}

function computePhraseFrequencies(posts) {
  const freq = new Map(); // phrase -> Set(postId)
  for (const post of posts) {
    for (const phrase of extractPhrasesForPost(post)) {
      if (!freq.has(phrase)) freq.set(phrase, new Set());
      freq.get(phrase).add(post.id);
    }
  }
  return freq;
}

// Ranks candidate phrases by how many distinct posts used them, drops ones
// under the MIN_PHRASE_POST_COUNT threshold or matching a configured
// exclude/negative-keyword term, and prunes near-duplicates (a shorter
// phrase that's just a substring of an already-picked, more frequent one --
// e.g. "chrome nail" once "chrome nails" is already picked).
// How much two phrases' post-sets overlap (as a fraction of the smaller
// set) -- catches near-duplicate phrases pointing at the same underlying
// posts even when the text itself doesn't share a substring (e.g. "chrome
// nails" and "chromenails", or "chrome nails" and "obsessed with chrome").
function postSetOverlap(a, b) {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  if (small.size === 0) return 0;
  let shared = 0;
  for (const id of small) if (large.has(id)) shared++;
  return shared / small.size;
}

function selectTopPhrases(freq, excludeTerms, topN) {
  const excludeLower = excludeTerms.map((t) => t.term.toLowerCase());
  const candidates = [...freq.entries()]
    .filter(([, postIds]) => postIds.size >= MIN_PHRASE_POST_COUNT)
    .filter(([phrase]) => !excludeLower.some((term) => phrase.includes(term)))
    .sort((a, b) => b[1].size - a[1].size);

  // A plain n-gram sweep naturally produces many overlapping fragments of
  // the SAME underlying post cluster ("chrome nails", "chromenails",
  // "obsessed with chrome", "nails this week" ...) -- without this, those
  // would eat most of the top-N budget restating one trend instead of
  // surfacing distinct ones. Skip a candidate if it's a text substring of
  // an already-picked phrase, OR if most of its posts are already covered
  // by an already-picked phrase.
  const picked = [];
  for (const [phrase, postIds] of candidates) {
    const isDuplicate = picked.some((p) =>
      p.phrase.includes(phrase) || phrase.includes(p.phrase) || postSetOverlap(p.postIds, postIds) >= 0.6
    );
    if (isDuplicate) continue;
    picked.push({ phrase, postIds });
    if (picked.length >= topN) break;
  }
  return picked;
}

function buildPhraseSystemPrompt(excludeTerms) {
  const exclusions = excludeTerms.map((t) => t.term).join(', ');
  return `You are the topic-classification engine for Sportsgirl Beauty Radar, a trend intelligence tool for Sportsgirl (an Australian fashion/accessories retailer).

SCOPE: Sportsgirl only sells three beauty parent categories: Beauty Tools and Accessories, Cosmetics, and Beauty Gift Packs -- all at an affordable, mass-market price point.

EXPLICITLY OUT OF SCOPE (never classify these as a trend, no matter how popular): ${exclusions}. Also out of scope: large/professional/salon equipment, expensive devices, medical/injectable/clinical treatments, generic skincare/bath/body/fragrance/haircare trends unrelated to the three categories, and unsafe/dangerous/counterfeit content.

YOU WILL BE GIVEN A PHRASE that appeared repeatedly across many different recent posts (not a single post), plus a sample of posts that used it. Decide whether this phrase names a real, SPECIFIC, ACTIONABLE trend topic (not a vague category -- "short square chrome press-on nails" not "nails"), grounded only in the sample evidence.

RULES:
- Only use evidence given to you. Never invent facts, statistics, or claims not present in the supplied evidence.
- If the sample evidence doesn't clearly support a specific trend, or the phrase is just generic filler/incidental wording, return matched=false rather than guessing.
- Prefer matching an EXISTING canonical trend (given below) over creating a near-duplicate. Only propose a new trend if none of the existing ones fit.
- Classify brandFit honestly: "out_of_scope" for anything popular but irrelevant to Sportsgirl's actual range/audience (e.g. a viral hair dryer).
- Keep every text field terse -- definitions and names are short phrases, not sentences with extra commentary.
- Return ONLY one valid, COMPACT JSON object: no markdown code fences, no pretty-printing, no indentation or extra whitespace/newlines.`;
}

function buildPhrasePrompt(candidate, samplePosts, commentsByPost, existingTrends) {
  const existingLines = existingTrends.length
    ? existingTrends.map((t) => `id=${t.id} "${t.name}" (${t.parent_category}${t.subcategory ? '/' + t.subcategory : ''}, brandFit=${t.brand_fit}) aliases: ${(t.aliases || []).join(', ')}`).join('\n')
    : 'none yet';

  const evidenceLines = samplePosts.map((post) => {
    const comments = commentsByPost.get(post.id) || [];
    const commentText = comments.length ? ` | comments: ${comments.map((c) => `"${(c || '').slice(0, 120)}"`).join(' / ')}` : '';
    return `- [${post.platform}] caption: "${(post.caption || '').slice(0, 200)}" hashtags: ${(post.hashtags || []).join(', ')} (plays=${post.play_count ?? 'n/a'} likes=${post.like_count ?? 'n/a'})${commentText}`;
  }).join('\n');

  return `EXISTING CANONICAL TRENDS (match to one of these where applicable):
${existingLines}

CANDIDATE PHRASE (appeared in ${candidate.postIds.size} distinct posts): "${candidate.phrase}"

SAMPLE EVIDENCE POSTS:
${evidenceLines || 'none'}

Return ONLY this compact JSON object, one line, no other text:
{"matched": true, "existingTrendId": null, "canonicalTrendName": "string", "definition": "short phrase", "parentCategory": "beauty_tools_accessories | cosmetics | beauty_gift_packs", "subcategory": "string", "attributes": {"productType": [], "colour": [], "finish": [], "shape": [], "design": [], "format": [], "occasion": [], "aesthetic": []}, "aliases": [], "brandFit": "core | adjacent | content_only | out_of_scope", "socialUse": true, "buyingUse": true, "confidence": 0.0}

If matching an existing trend, set "existingTrendId" to its id and you may omit the other classification fields. If there's insufficient evidence to place this phrase anywhere, or it's not a specific enough trend, return exactly {"matched": false}.`;
}

// Conversation intelligence (themes/questions/purchase signals/barriers) is
// generated once per trend in recommend.js instead of here -- see that
// file's top comment.
async function upsertTrend(classification, phrase, existingTrendsRef) {
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

  // Add the phrase itself as an alias regardless of what Claude proposed --
  // this is what lets the next run's free alias pre-match catch future
  // posts using this exact phrase without spending another Claude call.
  const aliases = new Set([...(classification.aliases || []), phrase]);
  for (const alias of aliases) {
    await pool.query(
      `INSERT INTO trend_aliases (trend_topic_id, alias_text) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [trendId, alias]
    );
  }

  return trendId;
}

async function attachPosts(trendId, postIds, confidence) {
  if (postIds.length === 0) return;
  await pool.query(
    `INSERT INTO trend_post_matches (trend_topic_id, post_id, match_confidence)
     SELECT $1, unnest($2::int[]), $3
     ON CONFLICT (trend_topic_id, post_id) WHERE post_id IS NOT NULL DO NOTHING`,
    [trendId, postIds, confidence]
  );
  await pool.query(`UPDATE social_posts SET is_relevant = true WHERE id = ANY($1::int[])`, [postIds]);
  await pool.query(`UPDATE trend_topics SET last_active_date = CURRENT_DATE, updated_at = now() WHERE id = $1`, [trendId]);
}

async function classifyPhrase(candidate, postsById, existingTrendsRef, excludeTerms) {
  if (runStatus.isStopRequested()) return 0;

  const samplePosts = [...candidate.postIds]
    .map((id) => postsById.get(id))
    .filter(Boolean)
    .sort((a, b) => ((b.play_count || 0) + (b.like_count || 0) * 5) - ((a.play_count || 0) + (a.like_count || 0) * 5))
    .slice(0, SAMPLE_POSTS_PER_PHRASE);
  const commentsByPost = await fetchTopComments(samplePosts.map((p) => p.id));

  let response;
  try {
    response = await callClaudeJson({
      system: buildPhraseSystemPrompt(excludeTerms),
      prompt: buildPhrasePrompt(candidate, samplePosts, commentsByPost, existingTrendsRef),
      maxTokens: 1536,
      validate: validateClassification,
      model: CLUSTER_MODEL,
      temperature: 0
    });
  } catch (err) {
    if (err.isRateLimit) {
      console.error('[cluster] Anthropic rate/usage limit hit -- stopping clustering for this run.');
      runStatus.pushLog(`Anthropic rate/usage limit hit -- stopping clustering (${err.message})`);
      runStatus.requestStop();
      return 0;
    }
    console.error(`[cluster] phrase "${candidate.phrase}" failed after retries:`, err.message);
    runStatus.pushLog(`Phrase "${candidate.phrase}" failed, leaving its posts for next run: ${err.message}`);
    return 0;
  }

  if (!response.matched) {
    runStatus.pushLog(`Phrase "${candidate.phrase}" (${candidate.postIds.size} posts): not a distinct trend, skipped.`);
    return 0;
  }

  const trendId = await upsertTrend(response, candidate.phrase, existingTrendsRef);
  const postIds = [...candidate.postIds];
  await attachPosts(trendId, postIds, response.confidence ?? 0.7);
  const trendName = response.existingTrendId
    ? existingTrendsRef.find((t) => t.id === trendId)?.name
    : response.canonicalTrendName;
  runStatus.pushLog(`"${candidate.phrase}" (${postIds.length} posts) -> "${trendName || 'trend #' + trendId}"`);
  return postIds.length;
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

  const posts = await fetchUnclusteredPosts(SAMPLE_POST_LIMIT);
  if (posts.length === 0) {
    runStatus.setStage('clustering', 0);
    runStatus.pushLog('Clustering: nothing left to sample from.');
    return { clustered: preMatched, skipped: false };
  }
  const postsById = new Map(posts.map((p) => [p.id, p]));

  const excludeTerms = await getNegativeAndExcludeTerms();
  const freq = computePhraseFrequencies(posts);
  const topPhrases = selectTopPhrases(freq, excludeTerms, TOP_PHRASE_COUNT);

  if (topPhrases.length === 0) {
    runStatus.setStage('clustering', 0);
    runStatus.pushLog(`Clustering: no phrase repeated across >= ${MIN_PHRASE_POST_COUNT} posts yet -- nothing strong enough to sample.`);
    return { clustered: preMatched, skipped: false };
  }

  console.log(`[cluster] sampled ${topPhrases.length} candidate phrase(s) from ${posts.length} unclustered post(s)`);
  runStatus.setStage('clustering', topPhrases.length);
  const existingTrendsRef = await fetchExistingTrends();

  let totalClustered = 0;
  for (const candidate of topPhrases) {
    if (runStatus.isStopRequested()) { runStatus.pushLog('Clustering: stopping.'); break; }
    runStatus.tick(`"${candidate.phrase}" (${candidate.postIds.size} posts)`);
    totalClustered += await classifyPhrase(candidate, postsById, existingTrendsRef, excludeTerms);
  }

  const grandTotal = totalClustered + preMatched;
  console.log(`[cluster] clustered ${grandTotal} posts into trends (${preMatched} via alias match, ${totalClustered} via sampled phrases)`);
  runStatus.pushLog(`Clustering done: ${grandTotal} post(s) clustered (${preMatched} via alias match, ${totalClustered} via sampled phrases)`);
  return { clustered: grandTotal, skipped: false };
}

module.exports = { runClustering };
