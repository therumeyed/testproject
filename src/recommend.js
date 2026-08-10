const { pool } = require('./db');
const { callClaudeJson, isConfigured } = require('./lib/claude');
const runStatus = require('./lib/runStatus');

// The newest Sonnet generation (ANTHROPIC_MODEL default) rejects
// temperature control outright (400 "temperature is deprecated for this
// model" -- confirmed live), which reintroduces an intermittent 0-char
// empty-response failure this call can't fully retry its way out of.
// Pinning recommendations to this older generation, which still honours
// temperature: 0, trades a little writing/reasoning polish for
// eliminating that failure mode entirely. Override via env if a future
// model needs a different pin.
const RECOMMEND_MODEL = process.env.ANTHROPIC_RECOMMEND_MODEL || 'claude-sonnet-4-5-20250929';

// Generates three client-facing, evidence-grounded outputs per trend in a
// single Claude call: conversation intelligence (themes/questions/purchase
// signals/barriers -- section 8), a Sportsgirl social content idea
// (section 9.3), and a buying recommendation (section 9.4). Conversation
// intelligence used to be generated separately inside cluster.js, once per
// clustering BATCH -- since a trend accumulates evidence across many
// batches over time, that meant redundantly regenerating it many times
// over for the same trend. Doing it once here, per trend, per run, grounded
// in that trend's accumulated evidence, is both cheaper and more coherent.
// Only generated once per trend -- regenerating on every run would both
// waste spend and stomp on a user's workflow status/notes. Feeding
// published performance / buyer decisions back in to *improve* future
// generations is Phase 3 (out of scope for this MVP pass).

async function fetchTopEvidence(trendId, limit = 8) {
  const { rows } = await pool.query(
    `SELECT sp.id, sp.platform, sp.url, sp.caption, sp.publish_ts, c.handle,
            pms.play_count, pms.like_count, pms.comment_count
     FROM trend_post_matches tpm
     JOIN social_posts sp ON sp.id = tpm.post_id
     LEFT JOIN creators c ON c.id = sp.creator_id
     LEFT JOIN LATERAL (
       SELECT play_count, like_count, comment_count FROM post_metric_snapshots
       WHERE post_id = sp.id ORDER BY snapshot_date DESC LIMIT 1
     ) pms ON true
     WHERE tpm.trend_topic_id = $1
     ORDER BY COALESCE(pms.play_count, 0) + COALESCE(pms.like_count, 0) * 5 DESC
     LIMIT $2`,
    [trendId, limit]
  );
  return rows;
}

async function fetchEvidenceComments(postIds) {
  if (postIds.length === 0) return [];
  const { rows } = await pool.query(
    `SELECT body FROM comments
     WHERE post_id = ANY($1::int[])
     ORDER BY (contains_purchase_intent::int + contains_question::int) DESC, score DESC NULLS LAST
     LIMIT 20`,
    [postIds]
  );
  return rows.map((r) => r.body).filter(Boolean);
}

async function fetchExistingRecTypes(trendId) {
  const { rows } = await pool.query(
    `SELECT DISTINCT rec_type FROM trend_recommendations WHERE trend_topic_id = $1 AND rec_type IN ('social_idea', 'buying_opportunity', 'conversation_summary')`,
    [trendId]
  );
  return new Set(rows.map((r) => r.rec_type));
}

function buildPrompt(trend, latestScore, evidence, comments) {
  const evidenceLines = evidence.map((e) =>
    `- [${e.platform}] by ${e.handle || 'unknown creator'}: "${(e.caption || '').slice(0, 150)}" (plays=${e.play_count ?? 'n/a'}, likes=${e.like_count ?? 'n/a'}, comments=${e.comment_count ?? 'n/a'}) ${e.url || ''}`
  ).join('\n');
  const commentLines = comments.length ? comments.map((c) => `"${c.slice(0, 200)}"`).join('\n') : 'none sampled';

  return `TREND: "${trend.name}"
Definition: ${trend.definition || 'n/a'}
Category: ${trend.parent_category} / ${trend.subcategory || 'n/a'}
Attributes: ${JSON.stringify(trend.attributes || {})}
Brand fit: ${trend.brand_fit}
Lifecycle stage: ${latestScore.lifecycle_stage}, durability: ${latestScore.durability_label}
Trend age: ${latestScore.trend_age_days} days, active ${latestScore.active_days} days (${latestScore.consecutive_active_days} consecutive)
Social Opportunity Score: ${latestScore.social_score}/100, Buying Opportunity Score: ${latestScore.buying_score}/100, Confidence: ${latestScore.confidence_score}/100
Australian validation: ${trend.market_au_state}

TOP EVIDENCE POSTS:
${evidenceLines || 'none'}

SAMPLE COMMENTS (from the evidence above):
${commentLines}

Using ONLY the evidence above:
1. Summarise what people are actually saying (conversation intelligence).
2. Produce a Sportsgirl-specific social content idea.
3. Produce a Sportsgirl-specific buying recommendation.

Sportsgirl is an Australian mass-market fashion/accessories retailer -- keep ideas affordable and on-brand, not luxury. Do NOT copy a creator's post; use the trend pattern to propose an original Sportsgirl execution. If evidence is too thin for a confident recommendation, say so explicitly in the relevant field rather than inventing detail.

Return ONLY this JSON object:
{
  "conversationSummary": {
    "conversationThemes": ["string -- main reasons people like/share this"],
    "questions": ["string -- common questions people ask"],
    "purchaseSignals": ["string -- product requests / purchase-intent statements"],
    "barriers": ["string -- objections, complaints, hesitations"],
    "confidence": 0.0
  },
  "socialIdea": {
    "title": "string",
    "format": "TikTok/Reel | carousel | story | tutorial | GRWM | product demo | trend recreation | comparison | creator collaboration",
    "audienceInsight": "string",
    "contentAngle": "string",
    "hook": "string",
    "visualExecution": "string",
    "structureGuidance": "string (suggested length/carousel structure)",
    "captionDirection": "string",
    "hashtags": ["string"],
    "treatmentType": "creator | staff | product-only | UGC-style",
    "productMatch": "string",
    "riskNotes": "string",
    "whyNow": "string",
    "effortLevel": "low | medium | high",
    "shelfLife": "post within 48 hours | this week | evergreen"
  },
  "buyingOpportunity": {
    "productOpportunity": "string",
    "attributes": "string (colour/finish/shape/design/pack format/occasion)",
    "evidenceOfPersistence": "string",
    "purchaseIntentEvidence": "string",
    "opportunityWindow": "string",
    "leadTimeRisk": "low | medium | high",
    "suggestedAction": "monitor | investigate | brief_supplier | test_small_run | pass",
    "reasoning": "string"
  }
}
If the trend is not suitable for social (evidence too weak / off-brand), set "socialIdea" to null. If not suitable for buying (content-only fit, or insufficient persistence/purchase-intent evidence), set "buyingOpportunity" to null.`;
}

function validateRecResponse(parsed) {
  if (!parsed || typeof parsed !== 'object') return 'response must be a JSON object';
  if (!('socialIdea' in parsed) || !('buyingOpportunity' in parsed) || !('conversationSummary' in parsed)) {
    return 'missing conversationSummary/socialIdea/buyingOpportunity keys';
  }
  if (parsed.socialIdea && !parsed.socialIdea.title) return 'socialIdea missing title';
  if (parsed.buyingOpportunity && !parsed.buyingOpportunity.productOpportunity) return 'buyingOpportunity missing productOpportunity';
  return null;
}

async function generateForTrend(trend, latestScore) {
  const existingTypes = await fetchExistingRecTypes(trend.id);
  if (existingTypes.has('social_idea') && existingTypes.has('buying_opportunity') && existingTypes.has('conversation_summary')) {
    return { generated: false };
  }

  const evidence = await fetchTopEvidence(trend.id);
  const comments = await fetchEvidenceComments(evidence.map((e) => e.id));

  const response = await callClaudeJson({
    system: 'You are the conversation-intelligence and recommendation engine for Sportsgirl Beauty Radar. Ground every claim in the supplied evidence; never invent facts.',
    prompt: buildPrompt(trend, latestScore, evidence, comments),
    maxTokens: 3072,
    validate: validateRecResponse,
    model: RECOMMEND_MODEL,
    // Same fix as cluster.js's classifyPhrase: at default temperature the
    // model occasionally lands its first sampled token on a stop token,
    // producing a genuine 0-char response (stop_reason=end_turn, not
    // max_tokens truncation). Each trend only gets ONE recommendation here
    // (not several variants to pick from), so there's no real use for
    // sampling randomness to trade away for that reliability. Requires
    // RECOMMEND_MODEL above -- the default ANTHROPIC_MODEL rejects this
    // parameter outright.
    temperature: 0
  });

  if (response.conversationSummary && !existingTypes.has('conversation_summary')) {
    await pool.query(
      `INSERT INTO trend_recommendations (trend_topic_id, rec_type, payload) VALUES ($1, 'conversation_summary', $2)`,
      [trend.id, JSON.stringify(response.conversationSummary)]
    );
  }
  if (response.socialIdea && trend.social_use && !existingTypes.has('social_idea')) {
    await pool.query(
      `INSERT INTO trend_recommendations (trend_topic_id, rec_type, payload, status) VALUES ($1, 'social_idea', $2, 'new')`,
      [trend.id, JSON.stringify({ ...response.socialIdea, evidenceLinks: evidence.map((e) => e.url).filter(Boolean) })]
    );
  }
  if (response.buyingOpportunity && trend.buying_use && !existingTypes.has('buying_opportunity')) {
    await pool.query(
      `INSERT INTO trend_recommendations (trend_topic_id, rec_type, payload, status) VALUES ($1, 'buying_opportunity', $2, 'watch')`,
      [trend.id, JSON.stringify(response.buyingOpportunity)]
    );
  }

  return { generated: true };
}

async function runRecommendations() {
  if (!isConfigured()) {
    console.log('[recommend] skipped: ANTHROPIC_API_KEY not set');
    return { generated: 0, skipped: true };
  }

  const { rows: trends } = await pool.query(
    `SELECT t.*, ts.lifecycle_stage, ts.durability_label, ts.trend_age_days, ts.active_days,
            ts.consecutive_active_days, ts.social_score, ts.buying_score, ts.confidence_score
     FROM trend_topics t
     JOIN LATERAL (
       SELECT * FROM trend_scores WHERE trend_topic_id = t.id ORDER BY score_date DESC LIMIT 1
     ) ts ON true
     WHERE t.status = 'active'`
  );

  runStatus.setStage('recommendations', trends.length);
  let generated = 0;
  for (const trend of trends) {
    if (runStatus.isStopRequested()) { runStatus.pushLog('Recommendations: stopping.'); break; }
    runStatus.tick(trend.name);
    try {
      const result = await generateForTrend(trend, trend);
      if (result.generated) generated++;
    } catch (err) {
      if (err.isRateLimit) {
        console.error('[recommend] Anthropic rate/usage limit hit -- stopping recommendations for this run.');
        runStatus.pushLog(`Anthropic rate/usage limit hit -- stopping recommendations (${err.message})`);
        runStatus.requestStop();
        break;
      }
      console.error(`[recommend] trend ${trend.id} ("${trend.name}") failed:`, err.message);
      runStatus.pushLog(`Recommendation for "${trend.name}" failed: ${err.message}`);
    }
  }
  console.log(`[recommend] generated recommendations for ${generated} trend(s)`);
  runStatus.pushLog(`Recommendations done: generated for ${generated} trend(s)`);
  return { generated, skipped: false };
}

module.exports = { runRecommendations };
