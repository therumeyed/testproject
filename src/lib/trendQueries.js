const { pool } = require('../db');

const ACTION_LABELS = {
  post_now: 'Post now',
  create_social_series: 'Create a social series',
  feature_product: 'Feature an existing Sportsgirl product',
  investigate_buying: 'Investigate for buying',
  test_small_run: 'Test a small product run',
  monitor: 'Monitor -- not proven yet',
  ignore: "Ignore -- outside Sportsgirl's range or audience"
};

function summaryRowSql(whereClauses, params) {
  return `
    SELECT t.id, t.name, t.definition, t.parent_category, t.subcategory, t.attributes, t.brand_fit,
           t.status, t.market_au_state, t.safety_flag, t.first_detected_date, t.last_active_date,
           ts.score_date, ts.social_score, ts.buying_score, ts.confidence_score, ts.lifecycle_stage,
           ts.durability_label, ts.trend_age_days, ts.active_days, ts.consecutive_active_days,
           ts.days_since_peak, ts.source_agreement_count, ts.is_provisional, ts.components
    FROM trend_topics t
    LEFT JOIN LATERAL (
      SELECT * FROM trend_scores WHERE trend_topic_id = t.id ORDER BY score_date DESC LIMIT 1
    ) ts ON true
    WHERE ${whereClauses.length ? whereClauses.join(' AND ') : 'true'}
    ORDER BY COALESCE(ts.social_score, 0) + COALESCE(ts.buying_score, 0) DESC
  `;
}

async function attachPlatformMetrics(trendIds) {
  if (trendIds.length === 0) return new Map();
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (trend_topic_id, platform) trend_topic_id, platform, new_posts, cumulative_posts,
            plays_sum, plays_new, likes_sum, comments_sum, shares_sum, saves_sum, median_plays, unique_creators, top_creator_share
     FROM trend_daily_metrics WHERE trend_topic_id = ANY($1::int[]) ORDER BY trend_topic_id, platform, metric_date DESC`,
    [trendIds]
  );
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.trend_topic_id)) map.set(r.trend_topic_id, []);
    map.get(r.trend_topic_id).push(r);
  }
  return map;
}

async function attachGoogleTrendsDirection(trendIds) {
  if (trendIds.length === 0) return new Map();
  const { rows } = await pool.query(
    `SELECT trend_topic_id, country, series_date, interest_index FROM google_trends_series
     WHERE trend_topic_id = ANY($1::int[]) AND series_date >= CURRENT_DATE - INTERVAL '14 days'
     ORDER BY trend_topic_id, country, series_date`,
    [trendIds]
  );
  const byTrend = new Map();
  for (const r of rows) {
    if (!byTrend.has(r.trend_topic_id)) byTrend.set(r.trend_topic_id, { AU: [], GLOBAL: [] });
    byTrend.get(r.trend_topic_id)[r.country]?.push({ date: r.series_date, value: Number(r.interest_index) });
  }
  const result = new Map();
  for (const [id, series] of byTrend.entries()) {
    const au = series.AU;
    const direction = au.length >= 2 ? (au[au.length - 1].value >= au[0].value ? 'up' : 'down') : 'unknown';
    result.set(id, { auDirection: direction, hasData: au.length > 0 || series.GLOBAL.length > 0 });
  }
  return result;
}

function toSummary(row, platforms, gtrends) {
  const recommendedAction = row.components?.recommendedAction || null;
  return {
    id: row.id, name: row.name, definition: row.definition,
    parentCategory: row.parent_category, subcategory: row.subcategory, attributes: row.attributes,
    brandFit: row.brand_fit, status: row.status, marketAuState: row.market_au_state, safetyFlag: row.safety_flag,
    firstDetectedDate: row.first_detected_date, lastActiveDate: row.last_active_date,
    scoreDate: row.score_date, socialScore: row.social_score, buyingScore: row.buying_score,
    confidenceScore: row.confidence_score, lifecycleStage: row.lifecycle_stage, durabilityLabel: row.durability_label,
    trendAgeDays: row.trend_age_days, activeDays: row.active_days, consecutiveActiveDays: row.consecutive_active_days,
    daysSincePeak: row.days_since_peak, sourceAgreementCount: row.source_agreement_count, isProvisional: row.is_provisional,
    recommendedAction, recommendedActionLabel: recommendedAction ? ACTION_LABELS[recommendedAction] : null,
    platforms: platforms || [], googleTrends: gtrends || { auDirection: 'unknown', hasData: false }
  };
}

async function listTrends(filters = {}) {
  const where = [`t.status != 'merged'`];
  const params = [];
  if (!filters.includeSuppressed) where.push(`t.status != 'suppressed'`);
  if (filters.category) { params.push(filters.category); where.push(`t.parent_category = $${params.length}`); }
  if (filters.brandFit) { params.push(filters.brandFit); where.push(`t.brand_fit = $${params.length}`); }
  if (filters.marketAuState) { params.push(filters.marketAuState); where.push(`t.market_au_state = $${params.length}`); }
  if (filters.search) { params.push(`%${filters.search}%`); where.push(`t.name ILIKE $${params.length}`); }

  const { rows } = await pool.query(summaryRowSql(where, params), params);
  let filtered = rows;
  if (filters.lifecycleStage) filtered = filtered.filter((r) => r.lifecycle_stage === filters.lifecycleStage);
  if (filters.durabilityLabel) filtered = filtered.filter((r) => r.durability_label === filters.durabilityLabel);
  if (filters.minSocialScore) filtered = filtered.filter((r) => Number(r.social_score || 0) >= Number(filters.minSocialScore));
  if (filters.minBuyingScore) filtered = filtered.filter((r) => Number(r.buying_score || 0) >= Number(filters.minBuyingScore));
  if (filters.minConfidence) filtered = filtered.filter((r) => Number(r.confidence_score || 0) >= Number(filters.minConfidence));

  const ids = filtered.map((r) => r.id);
  const [platformsMap, gtrendsMap] = await Promise.all([attachPlatformMetrics(ids), attachGoogleTrendsDirection(ids)]);
  return filtered.map((r) => toSummary(r, platformsMap.get(r.id), gtrendsMap.get(r.id)));
}

async function getTrendDetail(id) {
  const { rows } = await pool.query(summaryRowSql([`t.id = $1`], [id]), [id]);
  if (rows.length === 0) return null;
  const [platformsMap, gtrendsMap] = await Promise.all([attachPlatformMetrics([id]), attachGoogleTrendsDirection([id])]);
  const summary = toSummary(rows[0], platformsMap.get(id), gtrendsMap.get(id));

  const [scoreHistory, dailySeries, aliases, evidence, recs, productMatches, gtSeries] = await Promise.all([
    pool.query(`SELECT score_date, social_score, buying_score, confidence_score, lifecycle_stage, durability_label FROM trend_scores WHERE trend_topic_id = $1 ORDER BY score_date`, [id]),
    pool.query(`SELECT metric_date, platform, new_posts, plays_new, plays_sum, likes_sum, comments_sum FROM trend_daily_metrics WHERE trend_topic_id = $1 ORDER BY metric_date`, [id]),
    pool.query(`SELECT alias_text, alias_type FROM trend_aliases WHERE trend_topic_id = $1`, [id]),
    pool.query(
      `SELECT sp.id, sp.platform, sp.url, sp.caption, sp.publish_ts, sp.thumbnail_url, c.handle, c.follower_count,
              pms.play_count, pms.like_count, pms.comment_count, pms.share_count, pms.save_count
       FROM trend_post_matches tpm
       JOIN social_posts sp ON sp.id = tpm.post_id
       LEFT JOIN creators c ON c.id = sp.creator_id
       LEFT JOIN LATERAL (SELECT * FROM post_metric_snapshots WHERE post_id = sp.id ORDER BY snapshot_date DESC LIMIT 1) pms ON true
       WHERE tpm.trend_topic_id = $1
       ORDER BY COALESCE(pms.play_count,0) + COALESCE(pms.like_count,0) * 5 DESC LIMIT 12`,
      [id]
    ),
    pool.query(`SELECT id, rec_type, payload, status, owner, notes, created_at, updated_at FROM trend_recommendations WHERE trend_topic_id = $1 ORDER BY created_at DESC`, [id]),
    pool.query(`SELECT tpm.match_type, tpm.match_reason, p.* FROM trend_product_matches tpm JOIN sportsgirl_products p ON p.id = tpm.product_id WHERE tpm.trend_topic_id = $1`, [id]),
    pool.query(`SELECT country, series_date, interest_index, is_breakout FROM google_trends_series WHERE trend_topic_id = $1 ORDER BY series_date`, [id])
  ]);

  const conversationSummary = recs.rows.filter((r) => r.rec_type === 'conversation_summary')[0]?.payload || null;

  return {
    ...summary,
    aliases: aliases.rows,
    scoreHistory: scoreHistory.rows,
    dailySeries: dailySeries.rows,
    evidence: evidence.rows,
    conversationSummary,
    recommendations: recs.rows.filter((r) => r.rec_type !== 'conversation_summary'),
    productMatches: productMatches.rows,
    googleTrendsSeries: gtSeries.rows,
    scoreComponents: rows[0].components || {}
  };
}

module.exports = { listTrends, getTrendDetail, ACTION_LABELS };
