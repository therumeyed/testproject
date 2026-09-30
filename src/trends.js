// Google Trends data via DataForSEO's Google Trends Explore API -- replaces
// an earlier direct-scrape approach that got blocked outright (a raw
// request from this project's own dev environment returned HTTP 429 on the
// very first try) and a subsequent Apify-actor approach. DataForSEO is a
// paid, documented, task-based API: POST a task, poll for completion, GET
// the result (see src/dataForSeoClient.js). Never calls trends.google.com
// directly.
const { runTasks } = require('./dataForSeoClient');
const {
  upsertTrendObservations,
  insertTrendRelatedQueries,
  insertTrendsRawResult,
  recordTrendsFetchAttempt
} = require('./db');

const LOCATION = 'Australia';
const LANGUAGE = 'English';
const SEARCH_TYPE = 'web';

// Grouped together in ONE interest-over-time request so Google normalises
// them against each other (comparable within this group) -- Trends compare
// mode allows up to 5 keywords.
const KEYWORD_GROUP = [
  'Melbourne Airport',
  'Melbourne Airport parking',
  'airport parking Melbourne',
  'Melbourne Airport pickup',
  'Melbourne Airport drop off'
];

// Related queries require exactly one seed keyword per request (DataForSEO:
// "to obtain ... google_trends_queries_list items, specify no more than 1
// keyword") -- "airport parking Melbourne" is dropped here since it's a
// near-duplicate of "Melbourne Airport parking" and would surface
// essentially the same related queries.
const RELATED_QUERY_SEEDS = [
  'Melbourne Airport',
  'Melbourne Airport parking',
  'Melbourne Airport pickup',
  'Melbourne Airport drop off'
];

// Each series is kept fully separate in storage and in every calculation --
// see trendsCalculations.js -- because Google normalises each request's
// scores against that request's own window, so e.g. daily_90d and
// weekly_5y values for the same keyword+date are not comparable numbers.
const SERIES = {
  DAILY_INTEREST: 'daily_90d',
  WEEKLY_INTEREST: 'weekly_5y',
  // "Daily" here describes fetch cadence (once/day), not the time window --
  // related queries aren't a time series. past_7_days is the standard
  // "what's spiking right now" discovery window.
  DAILY_RELATED: 'daily_7d',
  WEEKLY_RELATED: 'weekly_12m'
};

function baseTaskFields(timeRange) {
  return { location_name: LOCATION, language_name: LANGUAGE, type: SEARCH_TYPE, time_range: timeRange };
}

function buildInterestTask(timeRange) {
  return { ...baseTaskFields(timeRange), keywords: KEYWORD_GROUP, item_types: ['google_trends_graph'] };
}

function buildRelatedQueryTask(seed, timeRange) {
  return { ...baseTaskFields(timeRange), keywords: [seed], item_types: ['google_trends_queries_list'] };
}

// A related query's "value" is a string that's either a plain percentage
// (e.g. "1250" meaning +1250%) or the literal "Breakout" once the increase
// is too large/undefined a baseline for a percentage to mean anything --
// same convention Google's own UI uses.
function parseRelatedQueryValue(raw) {
  if (raw === null || raw === undefined) return { value: null, isBreakout: false };
  if (typeof raw === 'number') return { value: raw, isBreakout: false };
  const str = String(raw).trim();
  if (/breakout/i.test(str)) return { value: null, isBreakout: true };
  const num = Number(str.replace(/[,+%]/g, ''));
  return Number.isFinite(num) ? { value: num, isBreakout: false } : { value: null, isBreakout: false };
}

// One row per keyword per date point in the graph -- `values[i]` lines up
// positionally with `keywords[i]` on the SAME item (DataForSEO documents
// this pairing explicitly), so this is safe, unlike matching across
// separate API calls where positional trust would be misplaced.
function parseInterestGraph(task, series) {
  const result = task && task.result && task.result[0];
  const item = result && (result.items || []).find((i) => i.type === 'google_trends_graph');
  if (!item) return [];
  const keywords = item.keywords || result.keywords || [];
  const rows = [];
  for (const point of item.data || []) {
    if (point.missing_data) continue;
    keywords.forEach((keyword, i) => {
      const value = (point.values || [])[i];
      if (typeof value === 'number') {
        rows.push({ keyword, series, observationDate: point.date_from, value });
      }
    });
  }
  return rows;
}

function parseRelatedQueries(task, seedKeyword, series) {
  const result = task && task.result && task.result[0];
  const item = result && (result.items || []).find((i) => i.type === 'google_trends_queries_list');
  if (!item || !item.data) return [];
  const rows = [];
  for (const queryType of ['top', 'rising']) {
    for (const q of item.data[queryType] || []) {
      const { value, isBreakout } = parseRelatedQueryValue(q.value);
      rows.push({ seedKeyword, series, queryType, query: q.query, value, isBreakout });
    }
  }
  return rows;
}

// One task_post call carrying the grouped interest-over-time task plus one
// related-query task per seed -- fewer round trips, and DataForSEO bills
// per task either way so batching doesn't change cost.
async function runFetch({ requestType, interestSeries, interestTimeRange, relatedSeries, relatedTimeRange }) {
  try {
    const tasks = [
      buildInterestTask(interestTimeRange),
      ...RELATED_QUERY_SEEDS.map((seed) => buildRelatedQueryTask(seed, relatedTimeRange))
    ];
    const [interestResult, ...relatedResults] = await runTasks(tasks);

    const observations = parseInterestGraph(interestResult, interestSeries);
    await upsertTrendObservations(observations);
    await insertTrendsRawResult({
      requestType: `${requestType}_interest`,
      keywordGroup: KEYWORD_GROUP.join(', '),
      timeframe: interestTimeRange,
      rawResult: interestResult
    });

    const relatedRows = RELATED_QUERY_SEEDS.flatMap((seed, i) => parseRelatedQueries(relatedResults[i], seed, relatedSeries));
    await insertTrendRelatedQueries(relatedRows);
    await insertTrendsRawResult({
      requestType: `${requestType}_related`,
      keywordGroup: RELATED_QUERY_SEEDS.join(', '),
      timeframe: relatedTimeRange,
      rawResult: relatedResults
    });

    await recordTrendsFetchAttempt({ requestType, success: true });
    return { observations: observations.length, relatedQueries: relatedRows.length };
  } catch (err) {
    console.error(`[trends] ${requestType} fetch failed: ${err.statusCode ?? ''} ${err.statusMessage || err.message}`);
    await recordTrendsFetchAttempt({ requestType, success: false, statusCode: err.statusCode, error: err.message });
    throw err;
  }
}

function fetchDailyData() {
  return runFetch({
    requestType: 'daily',
    interestSeries: SERIES.DAILY_INTEREST,
    interestTimeRange: 'past_90_days',
    relatedSeries: SERIES.DAILY_RELATED,
    relatedTimeRange: 'past_7_days'
  });
}

function fetchWeeklyData() {
  return runFetch({
    requestType: 'weekly',
    interestSeries: SERIES.WEEKLY_INTEREST,
    interestTimeRange: 'past_5_years',
    relatedSeries: SERIES.WEEKLY_RELATED,
    relatedTimeRange: 'past_12_months'
  });
}

module.exports = {
  KEYWORD_GROUP,
  RELATED_QUERY_SEEDS,
  SERIES,
  buildInterestTask,
  buildRelatedQueryTask,
  parseRelatedQueryValue,
  parseInterestGraph,
  parseRelatedQueries,
  fetchDailyData,
  fetchWeeklyData
};
