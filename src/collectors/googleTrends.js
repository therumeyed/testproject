const { pool } = require('../db');
const repo = require('../lib/repo');
const runStatus = require('../lib/runStatus');

// Calls the same free, unauthenticated JSON endpoints trends.google.com
// itself uses to render its charts -- no API key, no Apify actor, no cost.
// This is the well-documented (if unofficial) protocol behind libraries
// like pytrends: an /explore call returns per-widget request tokens, which
// are then fed back to /widgetdata/multiline (interest over time) and
// /widgetdata/relatedsearches (rising queries, including "Breakout" status).
//
// IMPORTANT OPERATIONAL NOTE: this endpoint is known to hard-block requests
// from cloud/datacenter IP ranges (AWS, GCP, Azure, and by extension most
// PaaS hosts including Render) with a 429, independent of request pacing --
// this was confirmed while building this collector: every request to
// trends.google.com (both the API and the plain HTML page) returned 429
// from this project's dev sandbox, while google.com itself loaded fine, so
// it's a targeted block on the Trends subdomain rather than a general
// outage. It may or may not be blocked from Render's specific egress IP --
// check the Admin panel's Source Health for "google_trends" after a run to
// know for sure. If it's persistently blocked in production, the practical
// options are: front this collector with a small residential-proxy service
// (cheap for this source specifically, since call volume is tiny -- a
// handful of trends x 2 geos, once a day), or accept Google Trends as a
// best-effort confirmation layer -- the rest of the app already treats
// missing Google Trends data as "unavailable" rather than failing, so nothing
// else breaks if this one source can't get through.
const BASE = 'https://trends.google.com/trends/api';
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', Accept: 'application/json, text/plain, */*' };

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Responses are prefixed with an anti-JSON-hijacking header (classically
// ")]}',\n") before the actual JSON body -- strip up to the first { or [
// rather than assuming an exact fixed-length prefix, since that header has
// drifted slightly over the years.
function parseJsonp(text) {
  const idx = text.search(/[[{]/);
  if (idx === -1) throw new Error('no JSON body found in response');
  return JSON.parse(text.slice(idx));
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: HEADERS });
  const text = await res.text();
  if (!res.ok) {
    const hint = res.status === 429 ? ' (rate-limited/blocked -- see note in src/collectors/googleTrends.js)' : '';
    throw new Error(`HTTP ${res.status}${hint}`);
  }
  return parseJsonp(text);
}

async function fetchWidgets(term, geo) {
  const req = { comparisonItem: [{ keyword: term, geo, time: 'today 3-m' }], category: 0, property: '' };
  const url = `${BASE}/explore?hl=en-US&tz=-600&req=${encodeURIComponent(JSON.stringify(req))}`;
  const data = await fetchJson(url);
  return data.widgets || [];
}

async function fetchTimeline(widget) {
  const url = `${BASE}/widgetdata/multiline?hl=en-US&tz=-600&req=${encodeURIComponent(JSON.stringify(widget.request))}&token=${widget.token}`;
  const data = await fetchJson(url);
  return data.default?.timelineData || [];
}

async function fetchRisingQueries(widget) {
  const url = `${BASE}/widgetdata/relatedsearches?hl=en-US&tz=-600&req=${encodeURIComponent(JSON.stringify(widget.request))}&token=${widget.token}`;
  const data = await fetchJson(url);
  // rankedList[0] = "top" queries by relative popularity, [1] = "rising".
  return data.default?.rankedList?.[1]?.rankedKeyword || [];
}

async function collectOne(trend, geo) {
  const countryLabel = geo || 'GLOBAL';
  const widgets = await fetchWidgets(trend.name, geo);
  const timeseries = widgets.find((w) => w.id === 'TIMESERIES');
  const related = widgets.find((w) => w.id === 'RELATED_QUERIES');
  let fetched = 0;

  if (timeseries) {
    const timeline = await fetchTimeline(timeseries);
    for (const point of timeline) {
      const value = point.value?.[0];
      if (value === undefined || value === null) continue;
      const seriesDate = new Date(Number(point.time) * 1000).toISOString().slice(0, 10);
      fetched++;
      await pool.query(
        `INSERT INTO google_trends_series (trend_topic_id, country, search_term, series_date, interest_index)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (trend_topic_id, country, search_term, series_date) DO UPDATE SET interest_index = $5`,
        [trend.id, countryLabel, trend.name, seriesDate, value]
      );
    }
  }

  if (related) {
    await sleep(500);
    const rising = await fetchRisingQueries(related);
    const today = new Date().toISOString().slice(0, 10);
    for (const rq of rising.slice(0, 10)) {
      // Google marks a genuine breakout with value -1 and formattedValue "Breakout"
      // instead of a percentage-increase number.
      const risingValue = rq.value === -1 ? 'Breakout' : (rq.formattedValue || String(rq.value));
      await pool.query(
        `INSERT INTO trend_related_queries (trend_topic_id, country, query_text, rising_value, series_date) VALUES ($1,$2,$3,$4,$5)`,
        [trend.id, countryLabel, rq.query, risingValue, today]
      );
    }
  }

  return fetched;
}

// Runs per CANONICAL TREND (not per seed keyword) -- Google Trends
// validation only makes sense once clustering (cluster.js) has produced a
// specific trend name to search for. Called after clustering in ingest.js.
async function collectForActiveTrends() {
  const runId = await repo.startSourceRun('google_trends');
  const { rows: trends } = await pool.query(`SELECT id, name FROM trend_topics WHERE status = 'active' ORDER BY id`);
  runStatus.setStage('google_trends', trends.length);

  let fetched = 0;
  let failures = 0;
  try {
    for (const trend of trends) {
      runStatus.tick(trend.name);
      for (const geo of ['', 'AU']) {
        try {
          fetched += await collectOne(trend, geo);
        } catch (err) {
          failures++;
          console.error(`[google_trends] "${trend.name}" (${geo || 'GLOBAL'}) failed:`, err.message);
          runStatus.pushLog(`google_trends "${trend.name}" (${geo || 'GLOBAL'}) failed: ${err.message}`);
        }
        await sleep(800); // light pacing -- this is an unofficial endpoint, not a paid API with a documented rate limit
      }
    }

    const status = failures === 0 ? 'success' : (fetched > 0 ? 'partial' : 'error');
    await repo.finishSourceRun(runId, {
      status, itemsFetched: fetched, itemsNew: fetched,
      errorMessage: failures > 0 ? `${failures} of ${trends.length * 2} trend/geo lookups failed -- see logs (likely 429s if this is new)` : null
    });
    runStatus.pushLog(`Google Trends done: ${fetched} data point(s), ${failures} failure(s)`);
  } catch (err) {
    await repo.finishSourceRun(runId, { status: 'error', itemsFetched: fetched, errorMessage: err.message });
    throw err;
  }

  return { platform: 'google_trends', skipped: false, fetched, new: fetched };
}

module.exports = { collectForActiveTrends };
