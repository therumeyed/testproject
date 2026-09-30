// End-to-end test for GET /api/trends against a real server + DB: confirms
// the three sections (search demand, emerging searches, seasonality) read
// back correctly from trend_observations/trend_related_queries/
// trends_fetch_status, that stats are computed per-series (never mixing
// daily_90d and weekly_5y values), and that a failed-attempt status still
// surfaces the last successful data with `stale: true` rather than an empty
// panel. Gated on TEST_DATABASE_URL like the other DB-backed suites.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const skip = !TEST_DATABASE_URL ? 'set TEST_DATABASE_URL to a scratch database to run this suite' : false;
const PORT = process.env.TRENDS_TEST_PORT || 3994;
const BASE = `http://localhost:${PORT}`;

describe('GET /api/trends (DB-backed, real server)', { skip }, () => {
  let serverProcess;
  let db;

  before(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    db = require('../src/db');
    await db.initSchema();
    await db.pool.query('TRUNCATE TABLE trend_observations, trend_related_queries, trends_fetch_status');

    serverProcess = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
      env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL, PORT: String(PORT) },
      stdio: 'ignore'
    });
    for (let i = 0; i < 50; i++) {
      try {
        const res = await fetch(`${BASE}/health`);
        if (res.ok) return;
      } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error('server did not become healthy in time');
  });

  after(async () => {
    await db.pool.query('TRUNCATE TABLE trend_observations, trend_related_queries, trends_fetch_status');
    await db.pool.end();
    serverProcess.kill();
  });

  test('with nothing fetched yet, every section reports lastUpdated: null without erroring', async () => {
    const data = await (await fetch(`${BASE}/api/trends`)).json();
    assert.equal(data.searchDemand.lastUpdated, null);
    assert.equal(data.emergingSearches.lastUpdated, null);
    assert.equal(data.seasonality.lastUpdated, null);
    assert.equal(data.searchDemand.series.length, 5); // full KEYWORD_GROUP, even with no data yet
    assert.deepEqual(data.searchDemand.series[0].observations, []);
  });

  test('search demand: flags a spike for a keyword whose recent week jumped well above its 28-day baseline', async () => {
    const today = new Date();
    const rows = [];
    for (let i = 0; i < 35; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().slice(0, 10);
      rows.push({ keyword: 'Melbourne Airport', series: 'daily_90d', observationDate: dateStr, value: i < 7 ? 90 : 20 });
      rows.push({ keyword: 'Melbourne Airport parking', series: 'daily_90d', observationDate: dateStr, value: 30 });
    }
    await db.upsertTrendObservations(rows);
    await db.recordTrendsFetchAttempt({ requestType: 'daily', success: true });

    const data = await (await fetch(`${BASE}/api/trends`)).json();
    const spiked = data.searchDemand.series.find((s) => s.keyword === 'Melbourne Airport');
    const flat = data.searchDemand.series.find((s) => s.keyword === 'Melbourne Airport parking');
    assert.equal(spiked.stats.spikeStatus, 'spike');
    assert.equal(flat.stats.spikeStatus, 'normal');
    assert.ok(data.searchDemand.lastUpdated);
    assert.equal(data.searchDemand.stale, false);
  });

  test('emerging searches: only "rising" queries surface, and isMassiveGrowth is set at >=1000% or breakout', async () => {
    await db.insertTrendRelatedQueries([
      { seedKeyword: 'Melbourne Airport', series: 'daily_7d', queryType: 'top', query: 'melbourne airport arrivals', value: 90, isBreakout: false },
      { seedKeyword: 'Melbourne Airport', series: 'daily_7d', queryType: 'rising', query: 'melbourne airport strike', value: null, isBreakout: true },
      { seedKeyword: 'Melbourne Airport parking', series: 'daily_7d', queryType: 'rising', query: 'parking discount', value: 1200, isBreakout: false },
      { seedKeyword: 'Melbourne Airport parking', series: 'daily_7d', queryType: 'rising', query: 'long term parking', value: 150, isBreakout: false }
    ]);
    const data = await (await fetch(`${BASE}/api/trends`)).json();
    const general = data.emergingSearches.themes.find((t) => t.theme === 'Melbourne Airport');
    assert.equal(general.queries.length, 1); // "top" query excluded
    assert.equal(general.queries[0].isMassiveGrowth, true); // breakout counts as massive

    const parking = data.emergingSearches.themes.find((t) => t.theme === 'Melbourne Airport parking');
    const massive = parking.queries.find((q) => q.query === 'parking discount');
    const notMassive = parking.queries.find((q) => q.query === 'long term parking');
    assert.equal(massive.isMassiveGrowth, true);
    assert.equal(notMassive.isMassiveGrowth, false);
  });

  test('a fresh failed attempt after a prior success keeps the old data but flags stale: true', async () => {
    await db.recordTrendsFetchAttempt({ requestType: 'daily', success: false, statusCode: 40501, error: 'invalid field' });
    const data = await (await fetch(`${BASE}/api/trends`)).json();
    assert.equal(data.searchDemand.stale, true);
    assert.ok(data.searchDemand.lastUpdated, 'previous successful data must still be present, not cleared');
    assert.ok(data.searchDemand.series.some((s) => s.observations.length > 0));
  });

  test('daily and weekly series never mix: seasonality reads only weekly_5y, unaffected by daily_90d data', async () => {
    const data = await (await fetch(`${BASE}/api/trends`)).json();
    const seasonalityKw = data.seasonality.series.find((s) => s.keyword === 'Melbourne Airport');
    assert.deepEqual(seasonalityKw.observations, []); // only daily_90d rows were ever inserted for this test
    assert.equal(seasonalityKw.yoy, null);
  });
});
