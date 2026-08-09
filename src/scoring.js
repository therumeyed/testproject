// Deterministic, code-only scoring engine. Per requirements section 7.6:
// "Never let an LLM invent the numeric score. Code must calculate it from
// stored metrics." Claude is used elsewhere (cluster.js, recommend.js) for
// language interpretation only.
const { pool } = require('./db');
const { getConfig } = require('./config/seedConfig');

const FORMULA_VERSION = '1.0.0';
const PLATFORMS = ['tiktok', 'instagram', 'reddit'];

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function log1pScale(value, midpoint) {
  // 0 at value=0, ~63 at value=midpoint, asymptotic toward 100. Keeps one
  // huge outlier post/trend from flattening every other topic's score.
  if (value == null || value <= 0) return 0;
  return clamp(100 * (1 - Math.exp(-value / midpoint)), 0, 100);
}

function daysBetween(a, b) {
  return Math.round((new Date(b) - new Date(a)) / (1000 * 60 * 60 * 24));
}

// ---------------------------------------------------------------------
// Daily metrics rollup (per trend, per platform, per day) -- pure counts,
// sums, medians and deltas from stored snapshots.
// ---------------------------------------------------------------------
async function computeDailyMetricsForTrend(trendId, dateStr, activityThreshold) {
  for (const platform of PLATFORMS) {
    const { rows } = await pool.query(
      `WITH matched AS (
         SELECT sp.id, sp.creator_id, sp.first_seen_at::date AS first_seen_date, COALESCE(sp.is_pinned, false) AS is_pinned
         FROM social_posts sp
         JOIN trend_post_matches tpm ON tpm.post_id = sp.id
         WHERE tpm.trend_topic_id = $1 AND sp.platform = $2 AND sp.first_seen_at::date <= $3
       ),
       snap_today AS (
         SELECT m.id AS post_id, pms.play_count, pms.like_count, pms.comment_count, pms.share_count, pms.save_count
         FROM matched m
         LEFT JOIN LATERAL (
           SELECT * FROM post_metric_snapshots WHERE post_id = m.id AND snapshot_date <= $3 ORDER BY snapshot_date DESC LIMIT 1
         ) pms ON true
       ),
       snap_prev AS (
         SELECT m.id AS post_id, pms.play_count
         FROM matched m
         LEFT JOIN LATERAL (
           SELECT * FROM post_metric_snapshots WHERE post_id = m.id AND snapshot_date < $3 ORDER BY snapshot_date DESC LIMIT 1
         ) pms ON true
       ),
       creator_counts AS (
         SELECT creator_id, count(*) AS cnt FROM matched WHERE creator_id IS NOT NULL GROUP BY creator_id
       )
       SELECT
         (SELECT count(*) FROM matched WHERE first_seen_date = $3 AND is_pinned = false) AS new_posts,
         (SELECT count(*) FROM matched) AS cumulative_posts,
         (SELECT sum(play_count) FROM snap_today) AS plays_sum,
         (SELECT sum(GREATEST(st.play_count - COALESCE(sp2.play_count, 0), 0))
            FROM snap_today st JOIN snap_prev sp2 ON sp2.post_id = st.post_id
            WHERE st.play_count IS NOT NULL) AS plays_new,
         (SELECT sum(like_count) FROM snap_today) AS likes_sum,
         (SELECT sum(comment_count) FROM snap_today) AS comments_sum,
         (SELECT sum(share_count) FROM snap_today) AS shares_sum,
         (SELECT sum(save_count) FROM snap_today) AS saves_sum,
         (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY play_count) FROM snap_today WHERE play_count IS NOT NULL) AS median_plays,
         (SELECT count(*) FROM creator_counts) AS unique_creators,
         (SELECT CASE WHEN (SELECT count(*) FROM matched WHERE creator_id IS NOT NULL) = 0 THEN NULL
                 ELSE (SELECT max(cnt) FROM creator_counts)::numeric / (SELECT count(*) FROM matched WHERE creator_id IS NOT NULL) END) AS top_creator_share,
         (SELECT count(*) FROM comments c JOIN matched m ON m.id = c.post_id WHERE c.contains_purchase_intent) AS purchase_intent_mentions,
         (SELECT count(*) FROM comments c JOIN matched m ON m.id = c.post_id WHERE c.contains_question) AS question_mentions
       `,
      [trendId, platform, dateStr]
    );

    const r = rows[0];
    if (Number(r.cumulative_posts) === 0) continue; // no evidence on this platform -- skip the row entirely

    const meetsThreshold = Number(r.new_posts) >= activityThreshold.min_new_posts;

    await pool.query(
      `INSERT INTO trend_daily_metrics (
         trend_topic_id, metric_date, platform, new_posts, cumulative_posts, plays_sum, plays_new,
         likes_sum, comments_sum, shares_sum, saves_sum, median_plays, unique_creators, top_creator_share,
         purchase_intent_mentions, question_mentions, meets_activity_threshold
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       ON CONFLICT (trend_topic_id, metric_date, platform) DO UPDATE SET
         new_posts = $4, cumulative_posts = $5, plays_sum = $6, plays_new = $7, likes_sum = $8,
         comments_sum = $9, shares_sum = $10, saves_sum = $11, median_plays = $12, unique_creators = $13,
         top_creator_share = $14, purchase_intent_mentions = $15, question_mentions = $16, meets_activity_threshold = $17`,
      [
        trendId, dateStr, platform, r.new_posts, r.cumulative_posts, r.plays_sum, r.plays_new,
        r.likes_sum, r.comments_sum, r.shares_sum, r.saves_sum, r.median_plays, r.unique_creators,
        r.top_creator_share, r.purchase_intent_mentions, r.question_mentions, meetsThreshold
      ]
    );
  }
}

async function computeAllDailyMetrics(dateStr) {
  const activityThreshold = await getConfig('activity_threshold');
  const { rows: trends } = await pool.query(`SELECT id FROM trend_topics WHERE status != 'merged'`);
  for (const t of trends) {
    await computeDailyMetricsForTrend(t.id, dateStr, activityThreshold);
  }
  return trends.length;
}

// ---------------------------------------------------------------------
// Age, persistence and lifecycle (section 7.3 / 7.4)
// ---------------------------------------------------------------------
async function getDailySeries(trendId) {
  const { rows } = await pool.query(
    `SELECT metric_date, SUM(new_posts)::int AS new_posts, SUM(COALESCE(plays_new,0))::bigint AS plays_new
     FROM trend_daily_metrics WHERE trend_topic_id = $1 GROUP BY metric_date ORDER BY metric_date`,
    [trendId]
  );
  return rows;
}

async function computeAgeAndLifecycle(trend, asOfDateStr, thresholds) {
  const series = await getDailySeries(trend.id);
  const activityThreshold = thresholds.activity.min_new_posts;

  const days = series.map((r) => ({
    date: r.metric_date.toISOString().slice(0, 10),
    momentum: Number(r.plays_new) + Number(r.new_posts) * 500, // heuristic blend so text-only platforms still register
    newPosts: Number(r.new_posts),
    isActive: Number(r.new_posts) >= activityThreshold
  }));

  const firstDetected = trend.first_detected_date
    ? trend.first_detected_date.toISOString().slice(0, 10)
    : (days[0]?.date || asOfDateStr);
  const trendAgeDays = Math.max(0, daysBetween(firstDetected, asOfDateStr));
  const activeDays = days.filter((d) => d.isActive).length;

  let consecutiveActiveDays = 0;
  for (let i = days.length - 1; i >= 0; i--) {
    if (days[i].isActive) consecutiveActiveDays++;
    else break;
  }

  let peakDay = null;
  for (const d of days) {
    if (!peakDay || d.momentum > peakDay.momentum) peakDay = d;
  }
  const daysSincePeak = peakDay ? daysBetween(peakDay.date, asOfDateStr) : trendAgeDays;

  // Recurrence: an inactive gap of >= recurrence_gap_days followed by a
  // later active run.
  let isRecurring = false;
  let gapLen = 0;
  for (let i = 0; i < days.length; i++) {
    if (!days[i].isActive) gapLen++;
    else {
      if (gapLen >= thresholds.lifecycle.recurrence_gap_days && i > 0) isRecurring = true;
      gapLen = 0;
    }
  }

  const last7 = days.slice(-7).reduce((s, d) => s + d.momentum, 0);
  const prior7 = days.slice(-14, -7).reduce((s, d) => s + d.momentum, 0);
  const growthPct = prior7 > 0 ? ((last7 - prior7) / prior7) * 100 : (last7 > 0 ? 100 : 0);
  const last30 = days.slice(-30).reduce((s, d) => s + d.momentum, 0);
  const prior30 = days.slice(-60, -30).reduce((s, d) => s + d.momentum, 0);
  const growth30Pct = prior30 > 0 ? ((last30 - prior30) / prior30) * 100 : (last30 > 0 ? 100 : 0);

  const lt = thresholds.lifecycle;
  let lifecycleStage;
  if (trendAgeDays <= lt.new_signal_max_age_days) {
    lifecycleStage = 'new_signal';
  } else if (isRecurring && days[days.length - 1]?.isActive) {
    lifecycleStage = 'recurring_seasonal';
  } else if (consecutiveActiveDays >= lt.sustained_consecutive_days && growthPct > -lt.cooling_decline_pct) {
    lifecycleStage = 'sustained';
  } else if (daysSincePeak <= 1 && Math.abs(growthPct) <= lt.peaking_flatten_pct && last7 > 0) {
    lifecycleStage = 'peaking';
  } else if (growthPct >= lt.accelerating_growth_pct) {
    lifecycleStage = 'accelerating';
  } else if (growthPct <= -lt.cooling_decline_pct) {
    lifecycleStage = 'cooling';
  } else if (last7 > 0) {
    lifecycleStage = 'emerging';
  } else {
    lifecycleStage = 'new_signal';
  }

  // Durability label: active_days against configured ranges.
  const dt = thresholds.durability;
  let durabilityLabel = 'flash';
  for (const [label, range] of Object.entries(dt)) {
    const [min, max] = range;
    if (activeDays >= min && (max === null || activeDays <= max)) durabilityLabel = label;
  }
  if (isRecurring) durabilityLabel = 'established';

  return {
    firstDetected, trendAgeDays, activeDays, consecutiveActiveDays, daysSincePeak,
    lifecycleStage, durabilityLabel, isRecurring, growthPct, growth30Pct, last7, prior7, days
  };
}

// ---------------------------------------------------------------------
// Score components
// ---------------------------------------------------------------------
async function getLatestPlatformAggregates(trendId) {
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (platform) platform, plays_sum, likes_sum, comments_sum, shares_sum, saves_sum,
            unique_creators, top_creator_share, purchase_intent_mentions, question_mentions
     FROM trend_daily_metrics WHERE trend_topic_id = $1 ORDER BY platform, metric_date DESC`,
    [trendId]
  );
  return rows;
}

async function getGoogleTrendsSignal(trendId) {
  const { rows } = await pool.query(
    `SELECT country, series_date, interest_index, is_breakout FROM google_trends_series
     WHERE trend_topic_id = $1 ORDER BY series_date DESC LIMIT 30`,
    [trendId]
  );
  const au = rows.filter((r) => r.country === 'AU');
  const global = rows.filter((r) => r.country === 'GLOBAL');
  const latestAu = au[0]?.interest_index ?? null;
  const priorAu = au[7]?.interest_index ?? null;
  const auDirection = latestAu != null && priorAu != null ? latestAu - priorAu : null;
  return {
    hasData: rows.length > 0,
    latestAu, auDirection,
    latestGlobal: global[0]?.interest_index ?? null,
    auBreakout: au.some((r) => r.is_breakout)
  };
}

async function getConversationConfidence(trendId) {
  const { rows } = await pool.query(
    `SELECT payload FROM trend_recommendations WHERE trend_topic_id = $1 AND rec_type = 'conversation_summary' ORDER BY created_at DESC LIMIT 5`,
    [trendId]
  );
  const confs = rows.map((r) => r.payload?.confidence).filter((c) => typeof c === 'number');
  return confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : 0.5;
}

async function getProductMatchStrength(trendId) {
  const { rows } = await pool.query(
    `SELECT match_type FROM trend_product_matches WHERE trend_topic_id = $1 ORDER BY
       CASE match_type WHEN 'exact' THEN 1 WHEN 'similar' THEN 2 WHEN 'family_only' THEN 3 ELSE 4 END LIMIT 1`,
    [trendId]
  );
  const type = rows[0]?.match_type;
  if (type === 'exact') return { value: 100, label: 'Matches an existing Sportsgirl product exactly' };
  if (type === 'similar') return { value: 70, label: 'Similar to an existing Sportsgirl product' };
  if (type === 'family_only') return { value: 35, label: 'Only a broad product-family match exists' };
  return { value: 10, label: 'No Sportsgirl product match on file yet' };
}

const BRAND_FIT_SOCIAL = { core: 100, adjacent: 80, content_only: 90, out_of_scope: 0 };
const BRAND_FIT_RANGE = { core: 100, adjacent: 70, content_only: 15, out_of_scope: 0 };
const AU_STATE_CONFIDENCE = { confirmed: 100, emerging: 60, absent: 20, unavailable: 10 };
const AU_STATE_BUYING = { confirmed: 100, emerging: 60, absent: 10, unavailable: 30 };

function pushComponent(components, key, label, value, weight, explanation) {
  const contribution = (value / 100) * weight;
  components.push({ key, label, value: Math.round(value), weight, contribution: Math.round(contribution * 10) / 10, explanation });
  return contribution;
}

async function computeScoresForTrend(trend, ageInfo, weights) {
  const platformAgg = await getLatestPlatformAggregates(trend.id);
  const gtrends = await getGoogleTrendsSignal(trend.id);
  const clusteringConfidence = await getConversationConfidence(trend.id);
  const productMatch = await getProductMatchStrength(trend.id);

  const { rows: totalRows } = await pool.query(
    `SELECT count(*)::int AS total_posts, count(DISTINCT creator_id)::int AS total_creators
     FROM social_posts sp JOIN trend_post_matches tpm ON tpm.post_id = sp.id WHERE tpm.trend_topic_id = $1`,
    [trend.id]
  );
  const evidenceCount = totalRows[0]?.total_posts || 0;
  const uniqueCreators = totalRows[0]?.total_creators || 0;
  const platformsWithEvidence = platformAgg.length;
  const maxTopCreatorShare = Math.max(0, ...platformAgg.map((p) => Number(p.top_creator_share) || 0));
  const totalPurchaseIntent = platformAgg.reduce((s, p) => s + (Number(p.purchase_intent_mentions) || 0), 0);
  const totalComments = platformAgg.reduce((s, p) => s + (Number(p.comments_sum) || 0), 0);

  const attrs = trend.attributes || {};
  const specificityFields = ['productType', 'colour', 'finish', 'shape', 'design', 'format', 'occasion'];
  const specificityFilled = specificityFields.filter((f) => Array.isArray(attrs[f]) && attrs[f].length > 0).length;

  const totalEngagement = platformAgg.reduce((s, p) => s + (Number(p.likes_sum) || 0) + 2 * (Number(p.comments_sum) || 0) + 3 * (Number(p.shares_sum) || 0) + 3 * (Number(p.saves_sum) || 0), 0);
  const totalPlays = platformAgg.reduce((s, p) => s + (Number(p.plays_sum) || 0), 0);
  const engagementRate = totalPlays > 0 ? totalEngagement / totalPlays : (totalEngagement > 0 ? 0.05 : 0);

  const isSafe = !trend.safety_flag;

  // --- Social Opportunity Score ---------------------------------------
  const sw = weights.social;
  const socialComponents = [];
  let social = 0;
  social += pushComponent(socialComponents, 'momentum_freshness', 'Momentum & freshness', clamp(50 + ageInfo.growthPct / 2, 0, 100), sw.momentum_freshness,
    `7-day momentum change of ${ageInfo.growthPct.toFixed(0)}% vs the prior 7 days.`);
  social += pushComponent(socialComponents, 'engagement_quality', 'Engagement quality', clamp(engagementRate * 1000, 0, 100), sw.engagement_quality,
    `Weighted engagement rate (shares/saves/comments weighted higher than likes) of ${(engagementRate * 100).toFixed(1)}% of plays.`);
  social += pushComponent(socialComponents, 'creator_breadth', 'Creator breadth', clamp(log1pScale(uniqueCreators, 15) - maxTopCreatorShare * 30, 0, 100), sw.creator_breadth,
    `${uniqueCreators} independent creator(s) across ${platformsWithEvidence} platform(s)${maxTopCreatorShare > 0.5 ? '; concentrated in one creator, reducing this' : ''}.`);
  social += pushComponent(socialComponents, 'relevance', "Relevance to Sportsgirl's audience", BRAND_FIT_SOCIAL[trend.brand_fit] ?? 50, sw.relevance,
    `Brand-fit classification: ${trend.brand_fit}.`);
  const videoRatio = platformAgg.some((p) => p.platform !== 'reddit') ? 80 : 30;
  social += pushComponent(socialComponents, 'visual_quality', 'Visual/demonstrable quality', videoRatio, sw.visual_quality,
    'Proxy based on the share of evidence that is video/visual content vs text-only.');
  social += pushComponent(socialComponents, 'product_connection', 'Connects to a Sportsgirl product', productMatch.value, sw.product_connection, productMatch.label);

  let socialSaturationPenalty = 0;
  if (maxTopCreatorShare > 0.6) {
    socialSaturationPenalty = clamp((maxTopCreatorShare - 0.6) * sw.saturation_penalty_max * 2.5, 0, sw.saturation_penalty_max);
  }
  if (socialSaturationPenalty > 0) {
    socialComponents.push({ key: 'saturation_penalty', label: 'Saturation penalty', value: -Math.round(socialSaturationPenalty), weight: 0, contribution: -Math.round(socialSaturationPenalty * 10) / 10, explanation: 'Most activity comes from one creator, reducing confidence this is a broad trend.' });
    social -= socialSaturationPenalty;
  }
  if (!isSafe) {
    socialComponents.push({ key: 'safety_penalty', label: 'Safety/brand-risk penalty', value: -100, weight: 0, contribution: -sw.safety_penalty_max, explanation: trend.safety_note || 'Flagged for safety/brand risk.' });
    social = clamp(social - sw.safety_penalty_max, 0, 5);
  }
  social = clamp(social, 0, 100);

  // --- Buying Opportunity Score ----------------------------------------
  const bw = weights.buying;
  const buyingComponents = [];
  let buying = 0;

  const dt = { flash: 15, early: 40, validated: 65, sustained: 85, established: 100 }[ageInfo.durabilityLabel] ?? 20;
  buying += pushComponent(buyingComponents, 'persistence_duration', 'Persistence & duration', dt, bw.persistence_duration,
    `Active for ${ageInfo.activeDays} day(s) (${ageInfo.consecutiveActiveDays} consecutive) -- durability label "${ageInfo.durabilityLabel}".`);

  const growthScore = (ageInfo.growthPct > 0 ? 50 : 0) + (ageInfo.growth30Pct > 0 ? 50 : 0);
  buying += pushComponent(buyingComponents, 'growth_multi_period', '7-day & 30-day growth', growthScore, bw.growth_multi_period,
    `7-day momentum ${ageInfo.growthPct >= 0 ? '+' : ''}${ageInfo.growthPct.toFixed(0)}%, 30-day ${ageInfo.growth30Pct >= 0 ? '+' : ''}${ageInfo.growth30Pct.toFixed(0)}%.`);

  buying += pushComponent(buyingComponents, 'australian_confirmation', 'Australian confirmation', AU_STATE_BUYING[trend.market_au_state] ?? 30, bw.australian_confirmation,
    trend.market_au_state === 'confirmed' ? 'Australian evidence and/or AU Google Trends confirms local demand.'
      : trend.market_au_state === 'emerging' ? 'Early Australian signal, not yet fully confirmed.'
      : trend.market_au_state === 'absent' ? 'No Australian evidence found yet.' : 'Australian evidence unavailable/not yet checked.');

  buying += pushComponent(buyingComponents, 'product_specificity', 'Product specificity', clamp((specificityFilled / specificityFields.length) * 100, 0, 100), bw.product_specificity,
    `${specificityFilled}/${specificityFields.length} product attributes identified (colour, finish, shape, etc.).`);

  buying += pushComponent(buyingComponents, 'purchase_intent', 'Purchase intent & product requests', log1pScale(totalPurchaseIntent, 8), bw.purchase_intent,
    `${totalPurchaseIntent} purchase-intent statement(s) found in the sampled comments.`);

  buying += pushComponent(buyingComponents, 'creator_breadth', 'Independent creator/community breadth', clamp(log1pScale(uniqueCreators, 15) - maxTopCreatorShare * 30, 0, 100), bw.creator_breadth,
    `${uniqueCreators} independent creator(s)/contributor(s).`);

  const gtScore = !gtrends.hasData ? 30 : gtrends.auBreakout ? 100 : (gtrends.auDirection > 0 ? 75 : gtrends.auDirection < 0 ? 30 : 50);
  buying += pushComponent(buyingComponents, 'google_trends_confirmation', 'Google Trends confirmation', gtScore, bw.google_trends_confirmation,
    !gtrends.hasData ? 'No Google Trends data collected yet for this topic.'
      : gtrends.auBreakout ? 'Australian search interest shows breakout growth.'
      : gtrends.auDirection > 0 ? 'Australian search interest is rising.' : 'Australian search interest is flat or declining.');

  buying += pushComponent(buyingComponents, 'range_fit', "Sportsgirl range & price-point fit", BRAND_FIT_RANGE[trend.brand_fit] ?? 20, bw.range_fit,
    `Brand-fit classification: ${trend.brand_fit}.`);

  const remainingWindowDays = (ageInfo.lifecycleStage === 'cooling' ? 14 : ageInfo.lifecycleStage === 'sustained' || ageInfo.lifecycleStage === 'recurring_seasonal' ? 90 : 45) - ageInfo.daysSincePeak;
  const leadTimeGapDays = remainingWindowDays - (weights.buyingLeadTimeDays ?? 45);
  let leadTimePenalty = 0;
  if (leadTimeGapDays < 0) {
    leadTimePenalty = clamp(Math.abs(leadTimeGapDays) / 30 * bw.lead_time_penalty_max, 0, bw.lead_time_penalty_max);
    buyingComponents.push({ key: 'lead_time_penalty', label: 'Buying lead-time risk', value: -Math.round(leadTimePenalty), weight: 0, contribution: -Math.round(leadTimePenalty * 10) / 10, explanation: `Estimated remaining trend window is shorter than Sportsgirl's ~${weights.buyingLeadTimeDays}-day buying lead time.` });
    buying -= leadTimePenalty;
  }

  let buyingSaturationPenalty = 0;
  if (maxTopCreatorShare > 0.7) {
    buyingSaturationPenalty = clamp((maxTopCreatorShare - 0.7) * bw.saturation_penalty_max * 3, 0, bw.saturation_penalty_max);
    buyingComponents.push({ key: 'saturation_penalty', label: 'Saturation penalty', value: -Math.round(buyingSaturationPenalty), weight: 0, contribution: -Math.round(buyingSaturationPenalty * 10) / 10, explanation: 'Evidence is concentrated in very few creators/communities.' });
    buying -= buyingSaturationPenalty;
  }
  if (!isSafe) {
    buyingComponents.push({ key: 'safety_penalty', label: 'Safety/compliance penalty', value: -100, weight: 0, contribution: -bw.safety_penalty_max, explanation: trend.safety_note || 'Flagged for safety/compliance risk.' });
    buying = clamp(buying - bw.safety_penalty_max, 0, 5);
  }
  buying = clamp(buying, 0, 100);

  // --- Confidence Score --------------------------------------------------
  const cw = weights.confidence;
  const confidenceComponents = [];
  let confidence = 0;
  confidence += pushComponent(confidenceComponents, 'evidence_volume', 'Evidence volume', log1pScale(evidenceCount, 20), cw.evidence_volume,
    `${evidenceCount} matched post(s)/comment(s) of evidence.`);
  confidence += pushComponent(confidenceComponents, 'source_coverage', 'Source coverage', clamp((platformsWithEvidence / 3) * 100, 0, 100), cw.source_coverage,
    `Evidence found on ${platformsWithEvidence} of 3 tracked platforms.`);
  const dataCompleteness = clamp(100 - (platformAgg.filter((p) => p.plays_sum == null && p.platform !== 'reddit').length * 20), 0, 100);
  confidence += pushComponent(confidenceComponents, 'data_completeness', 'Data completeness', dataCompleteness, cw.data_completeness,
    'Share of expected metric fields actually returned by source platforms.');
  confidence += pushComponent(confidenceComponents, 'geographic_confirmation', 'Geographic confirmation', AU_STATE_CONFIDENCE[trend.market_au_state] ?? 20, cw.geographic_confirmation,
    `Australian validation state: ${trend.market_au_state}.`);
  confidence += pushComponent(confidenceComponents, 'creator_diversity', 'Creator diversity', clamp(log1pScale(uniqueCreators, 15) - maxTopCreatorShare * 30, 0, 100), cw.creator_diversity,
    `${uniqueCreators} independent creator(s).`);
  confidence += pushComponent(confidenceComponents, 'clustering_certainty', 'Topic-clustering certainty', clamp(clusteringConfidence * 100, 0, 100), cw.clustering_certainty,
    'Model-reported confidence that evidence was clustered into the right canonical topic.');
  confidence = clamp(confidence, 0, 100);

  const { minEvidence } = weights;
  const isProvisional = evidenceCount < minEvidence.min_total_posts || uniqueCreators < minEvidence.min_unique_creators || !gtrends.hasData;

  const sourceAgreementCount = platformsWithEvidence + (gtrends.hasData ? 1 : 0) + (trend.market_au_state === 'confirmed' ? 1 : 0);

  return {
    socialScore: Math.round(social * 10) / 10,
    buyingScore: Math.round(buying * 10) / 10,
    confidenceScore: Math.round(confidence * 10) / 10,
    isProvisional,
    sourceAgreementCount,
    components: { social: socialComponents, buying: buyingComponents, confidence: confidenceComponents }
  };
}

// Deterministic recommended-action label -- the core product principle list
// (section 1). Content copy for the action is generated separately by
// Claude (recommend.js); this label drives filtering/sorting/badges.
function deriveRecommendedAction(trend, ageInfo, scores) {
  if (trend.brand_fit === 'out_of_scope') return 'ignore';
  if (scores.isProvisional && scores.confidenceScore < 40) return 'monitor';
  if (scores.socialScore >= 70 && ['accelerating', 'peaking', 'new_signal', 'emerging'].includes(ageInfo.lifecycleStage)) return 'post_now';
  if (scores.socialScore >= 55 && ageInfo.durabilityLabel !== 'flash') return 'create_social_series';
  if (scores.buyingScore >= 70 && ageInfo.durabilityLabel !== 'flash') return 'investigate_buying';
  if (scores.buyingScore >= 50 && ['validated', 'sustained', 'established'].includes(ageInfo.durabilityLabel)) return 'test_small_run';
  if (scores.socialScore >= 40 || scores.buyingScore >= 40) return 'monitor';
  return 'monitor';
}

async function computeAndStoreScores(dateStr) {
  const [durability, lifecycle, activity, weightsCfg, leadTime, minEvidence] = await Promise.all([
    getConfig('durability_thresholds'), getConfig('lifecycle_thresholds'), getConfig('activity_threshold'),
    getConfig('score_weights'), getConfig('buying_lead_time_days'), getConfig('min_evidence_threshold')
  ]);
  const thresholds = { durability, lifecycle, activity };
  const weights = { ...weightsCfg, buyingLeadTimeDays: leadTime, minEvidence };

  const { rows: trends } = await pool.query(`SELECT * FROM trend_topics WHERE status != 'merged'`);
  let scored = 0;

  for (const trend of trends) {
    const ageInfo = await computeAgeAndLifecycle(trend, dateStr, thresholds);
    const scores = await computeScoresForTrend(trend, ageInfo, weights);
    const recommendedAction = deriveRecommendedAction(trend, ageInfo, scores);

    await pool.query(
      `INSERT INTO trend_scores (
         trend_topic_id, score_date, formula_version, social_score, buying_score, confidence_score,
         lifecycle_stage, durability_label, trend_age_days, active_days, consecutive_active_days,
         days_since_peak, source_agreement_count, is_provisional, components
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (trend_topic_id, score_date) DO UPDATE SET
         formula_version=$3, social_score=$4, buying_score=$5, confidence_score=$6, lifecycle_stage=$7,
         durability_label=$8, trend_age_days=$9, active_days=$10, consecutive_active_days=$11,
         days_since_peak=$12, source_agreement_count=$13, is_provisional=$14, components=$15`,
      [
        trend.id, dateStr, FORMULA_VERSION, scores.socialScore, scores.buyingScore, scores.confidenceScore,
        ageInfo.lifecycleStage, ageInfo.durabilityLabel, ageInfo.trendAgeDays, ageInfo.activeDays,
        ageInfo.consecutiveActiveDays, ageInfo.daysSincePeak, scores.sourceAgreementCount, scores.isProvisional,
        JSON.stringify({ ...scores.components, recommendedAction })
      ]
    );

    await pool.query(
      `UPDATE trend_topics SET last_active_date = GREATEST(COALESCE(last_active_date, $2::date), $2::date), updated_at = now() WHERE id = $1 AND $3 = true`,
      [trend.id, dateStr, ageInfo.days[ageInfo.days.length - 1]?.isActive || false]
    );

    scored++;
  }

  return scored;
}

module.exports = {
  FORMULA_VERSION, computeAllDailyMetrics, computeAgeAndLifecycle, computeAndStoreScores, deriveRecommendedAction
};
