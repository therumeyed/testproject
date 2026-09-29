// End-to-end test for GET /api/trends and db.js's replaceTrendQueries/
// getLatestTrendQueries against a real server + DB. Gated on
// TEST_DATABASE_URL like the other DB-backed suites.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const skip = !TEST_DATABASE_URL ? 'set TEST_DATABASE_URL to a scratch database to run this suite' : false;
const PORT = process.env.TRENDS_TEST_PORT || 3995;
const BASE = `http://localhost:${PORT}`;

describe('GET /api/trends (DB-backed, real server)', { skip }, () => {
  let serverProcess;
  let db;

  before(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    db = require('../src/db');
    await db.initSchema();
    await db.pool.query('TRUNCATE TABLE trend_queries');

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
    await db.pool.query('TRUNCATE TABLE trend_queries');
    await db.pool.end();
    serverProcess.kill();
  });

  test('returns an empty theme list when nothing has been fetched yet', async () => {
    const data = await (await fetch(`${BASE}/api/trends`)).json();
    assert.deepEqual(data.themes, []);
    assert.equal(data.fetchedAt, null);
  });

  test('groups stored rows by theme, ordered by change percentage descending within each theme', async () => {
    await db.replaceTrendQueries([
      { theme: 'Parking', query: 'long term parking discount', changePct: 300, isBreakout: false, link: 'https://trends.google.com/x' },
      { theme: 'Parking', query: 'new parking rates', changePct: null, isBreakout: true, link: 'https://trends.google.com/y' },
      { theme: 'Pickup', query: 'pickup zone melbourne', changePct: 150, isBreakout: false, link: null }
    ]);

    const data = await (await fetch(`${BASE}/api/trends`)).json();
    assert.equal(data.themes.length, 2);
    const parking = data.themes.find((t) => t.theme === 'Parking');
    assert.equal(parking.queries.length, 2);
    // is_breakout rows sort first (NULLS LAST on change_pct in the query)
    assert.equal(parking.queries[0].query, 'new parking rates');
    assert.equal(parking.queries[0].isBreakout, true);
    assert.equal(parking.queries[1].changePct, 300);
    assert.ok(data.fetchedAt);
  });

  test('replaceTrendQueries fully replaces the previous fetch rather than appending', async () => {
    await db.replaceTrendQueries([{ theme: 'Drop-off', query: 'drop off changes', changePct: 500, isBreakout: false, link: null }]);
    const data = await (await fetch(`${BASE}/api/trends`)).json();
    assert.equal(data.themes.length, 1);
    assert.equal(data.themes[0].theme, 'Drop-off');
  });
});
