const { pool } = require('./db');
const { callClaudeJson, isConfigured } = require('./lib/claude');

// Generates the two client-facing, evidence-grounded outputs: a Sportsgirl
// social content idea (section 9.3) and a buying recommendation (section
// 9.4). Only generated once per trend per rec_type -- regenerating on every
// run would both waste spend and stomp on a user's workflow status/notes.
// Feeding published performance / buyer decisions back in to *improve*
// future generations is Phase 3 (out of scope for this MVP pass).

async function fetchConversationSummary(trendId) {
  const { rows } = await pool.query(
    `SELECT payload FROM trend_recommendations WHERE trend_topic_id = $1 AND rec_type = 'conversation_summary'
     ORDER BY created_at DESC LIMIT 3`,
    [trendId]
  );
  const themes = new Set(), questions = new Set(), purchaseSignals = new Set(), barriers = new Set();
  for (const r of rows) {
    (r.payload.conversationThemes || []).forEach((t) => themes.add(t));
    (r.payload.questions || []).forEach((t) => questions.add(t));
    (r.payload.purchaseSignals || []).forEach((t) => purchaseSignals.add(t));
    (r.payload.barriers || []).forEach((t) => barriers.add(t));
  }
  return {
    conversationThemes: [...themes], questions: [...questions],
    purchaseSignals: [...purchaseSignals], barriers: [...barriers]
  };
}

async function fetchTopEvidence(trendId, limit = 6) {
  const { rows } = await pool.query(
    `SELECT sp.platform, sp.url, sp.caption, sp.publish_ts, c.handle,
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

async function fetchExistingRecTypes(trendId) {
  const { rows } = await pool.query(
    `SELECT DISTINCT rec_type FROM trend_recommendations WHERE trend_topic_id = $1 AND rec_type IN ('social_idea', 'buying_opportunity')`,
    [trendId]
  );
  return new Set(rows.map((r) => r.rec_type));
}

function buildPrompt(trend, latestScore, conversation, evidence) {
  const evidenceLines = evidence.map((e) =>
    `- [${e.platform}] by ${e.handle || 'unknown creator'}: "${(e.caption || '').slice(0, 150)}" (plays=${e.play_count ?? 'n/a'}, likes=${e.like_count ?? 'n/a'}, comments=${e.comment_count ?? 'n/a'}) ${e.url || ''}`
  ).join('\n');

  return `TREND: "${trend.name}"
Definition: ${trend.definition || 'n/a'}
Category: ${trend.parent_category} / ${trend.subcategory || 'n/a'}
Attributes: ${JSON.stringify(trend.attributes || {})}
Brand fit: ${trend.brand_fit}
Lifecycle stage: ${latestScore.lifecycle_stage}, durability: ${latestScore.durability_label}
Trend age: ${latestScore.trend_age_days} days, active ${latestScore.active_days} days (${latestScore.consecutive_active_days} consecutive)
Social Opportunity Score: ${latestScore.social_score}/100, Buying Opportunity Score: ${latestScore.buying_score}/100, Confidence: ${latestScore.confidence_score}/100
Australian validation: ${trend.market_au_state}

CONVERSATION THEMES: ${conversation.conversationThemes.join('; ') || 'none extracted yet'}
QUESTIONS PEOPLE ASK: ${conversation.questions.join('; ') || 'none'}
PURCHASE SIGNALS: ${conversation.purchaseSignals.join('; ') || 'none'}
BARRIERS/OBJECTIONS: ${conversation.barriers.join('; ') || 'none'}

TOP EVIDENCE POSTS:
${evidenceLines || 'none'}

Using ONLY the evidence above, produce a Sportsgirl-specific social content idea and buying recommendation. Sportsgirl is an Australian mass-market fashion/accessories retailer -- keep ideas affordable and on-brand, not luxury. Do NOT copy a creator's post; use the trend pattern to propose an original Sportsgirl execution. If evidence is too thin for a confident recommendation, say so explicitly in the relevant field rather than inventing detail.

Return ONLY this JSON object:
{
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
  if (!('socialIdea' in parsed) || !('buyingOpportunity' in parsed)) return 'missing socialIdea/buyingOpportunity keys';
  if (parsed.socialIdea && !parsed.socialIdea.title) return 'socialIdea missing title';
  if (parsed.buyingOpportunity && !parsed.buyingOpportunity.productOpportunity) return 'buyingOpportunity missing productOpportunity';
  return null;
}

async function generateForTrend(trend, latestScore) {
  const existingTypes = await fetchExistingRecTypes(trend.id);
  if (existingTypes.has('social_idea') && existingTypes.has('buying_opportunity')) return { generated: false };

  const [conversation, evidence] = await Promise.all([
    fetchConversationSummary(trend.id), fetchTopEvidence(trend.id)
  ]);

  const response = await callClaudeJson({
    system: 'You are the social + buying recommendation engine for Sportsgirl Beauty Radar. Ground every claim in the supplied evidence; never invent facts.',
    prompt: buildPrompt(trend, latestScore, conversation, evidence),
    maxTokens: 2048,
    validate: validateRecResponse
  });

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

  let generated = 0;
  for (const trend of trends) {
    try {
      const result = await generateForTrend(trend, trend);
      if (result.generated) generated++;
    } catch (err) {
      console.error(`[recommend] trend ${trend.id} ("${trend.name}") failed:`, err.message);
    }
  }
  console.log(`[recommend] generated recommendations for ${generated} trend(s)`);
  return { generated, skipped: false };
}

module.exports = { runRecommendations };
