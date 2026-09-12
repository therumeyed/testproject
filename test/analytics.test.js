// End-to-end acceptance test: seeds a known dataset into a scratch DB, boots
// the real server against it, and asserts that /api/mentions and
// /api/analytics agree on combined filters and that every aggregate
// reconciles with the filtered total -- the core data-accuracy requirement
// from the brief. Gated on TEST_DATABASE_URL, same as db-category.test.js,
// so `npm test` can never touch a real database.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const skip = !TEST_DATABASE_URL ? 'set TEST_DATABASE_URL to a scratch database to run this suite' : false;
const PORT = process.env.ANALYTICS_TEST_PORT || 3999;
const BASE = `http://localhost:${PORT}`;

describe('combined filters + aggregate reconciliation (DB-backed, real server)', { skip }, () => {
  let serverProcess;
  let pool;

  before(async () => {
    const { Pool } = require('pg');
    pool = new Pool({ connectionString: TEST_DATABASE_URL });

    // Boot the real server against the scratch DB first so it creates the
    // schema, then seed fixture rows with explicit first_seen_at timestamps
    // (bypassing insertMentions's now()-default) so time-window filtering
    // and the previous-period comparison are fully deterministic.
    serverProcess = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
      env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL, PORT: String(PORT) },
      stdio: 'ignore'
    });
    await waitForHealth();
    await pool.query('TRUNCATE TABLE mentions RESTART IDENTITY');

    const now = Date.now();
    const daysAgo = (n) => new Date(now - n * 24 * 60 * 60 * 1000);
    const rows = [
      // current 14-day window
      ['reddit', 'a1', 'parking', 'negative', true, daysAgo(2)],
      ['google_reviews', 'a2', 'parking', 'negative', true, daysAgo(3)],
      ['youtube', 'a3', 'parking', 'positive', true, daysAgo(4)],
      ['youtube', 'a4', 'terminal_experience', 'positive', true, daysAgo(1)],
      ['reddit', 'a5', null, 'neutral', true, daysAgo(5)],
      // irrelevant -- must be excluded from every default aggregate
      ['reddit', 'a6', 'parking', 'negative', false, daysAgo(1)],
      // previous 14-day comparison window (14-28 days ago)
      ['reddit', 'a7', 'parking', 'negative', true, daysAgo(20)],
      ['facebook_direct', 'a8', 'taxi_rideshare', 'neutral', true, daysAgo(22)]
    ];
    for (const [source, external_id, category, sentiment, relevant, firstSeenAt] of rows) {
      await pool.query(
        `INSERT INTO mentions (source, external_id, title, snippet, category, category_source, sentiment, relevant, first_seen_at)
         VALUES ($1,$2,'t','s',$3,$4,$5,$6,$7)`,
        [source, external_id, category, category ? 'ai' : null, sentiment, relevant, firstSeenAt]
      );
    }
  });

  after(async () => {
    await pool.query('TRUNCATE TABLE mentions RESTART IDENTITY');
    await pool.end();
    serverProcess.kill();
  });

  async function waitForHealth() {
    for (let i = 0; i < 50; i++) {
      try {
        const res = await fetch(`${BASE}/health`);
        if (res.ok) return;
      } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error('server did not become healthy in time');
  }

  test('default (unfiltered) analytics: sentiment and category totals reconcile with the overall total, excluding irrelevant rows', async () => {
    const a = await (await fetch(`${BASE}/api/analytics`)).json();
    assert.equal(a.total, 5); // a1-a5, a6 excluded (relevant=false), a7/a8 outside the 14-day window

    const sentimentSum = a.sentiment.positive.count + a.sentiment.neutral.count + a.sentiment.negative.count + a.sentiment.unclassified.count;
    assert.equal(sentimentSum, a.total);
    assert.equal(a.sentiment.negative.count, 2);
    assert.equal(a.sentiment.positive.count, 2);
    assert.equal(a.sentiment.neutral.count, 1);

    const categorySum = a.categories.reduce((s, c) => s + c.count, 0);
    assert.equal(categorySum, a.total);
    assert.equal(a.categories.find((c) => c.category === 'parking').count, 3);
    assert.equal(a.categories.find((c) => c.category === 'terminal_experience').count, 1);
    assert.equal(a.categories.find((c) => c.category === 'unclassified').count, 1);

    // negativeByCategory must sum to the overall negative count
    const negSum = a.negativeByCategory.reduce((s, c) => s + c.count, 0);
    assert.equal(negSum, a.sentiment.negative.count);
  });

  test('previous-period comparison uses the immediately preceding 14-day window', async () => {
    const a = await (await fetch(`${BASE}/api/analytics`)).json();
    assert.equal(a.previousPeriod.total, 2); // a7, a8
    assert.equal(a.previousPeriod.totalChangePct, 150); // (5-2)/2 * 100
    assert.equal(a.previousPeriod.sentiment.negative.count, 1);
    assert.equal(a.previousPeriod.sentiment.neutral.count, 1);
  });

  test('/api/mentions and /api/analytics agree on the same category filter', async () => {
    const mentions = await (await fetch(`${BASE}/api/mentions?category=parking&pageSize=200`)).json();
    const a = await (await fetch(`${BASE}/api/analytics?category=parking`)).json();
    assert.equal(mentions.total, 3);
    assert.equal(a.total, 3);
    assert.equal(mentions.results.length, 3);
    assert.ok(mentions.results.every((r) => r.category === 'parking'));
  });

  test('combining category + sentiment filters (AND logic) narrows both endpoints identically', async () => {
    const mentions = await (await fetch(`${BASE}/api/mentions?category=parking&sentiment=negative&pageSize=200`)).json();
    const a = await (await fetch(`${BASE}/api/analytics?category=parking&sentiment=negative`)).json();
    assert.equal(mentions.total, 2); // a1, a2 only -- a3 (parking/positive) and a6 (irrelevant) excluded
    assert.equal(a.total, 2);
    assert.ok(mentions.results.every((r) => r.category === 'parking' && r.sentiment === 'negative'));
  });

  test('clearing filters (days=14, no other params) restores the default unfiltered view', async () => {
    const a = await (await fetch(`${BASE}/api/analytics?days=14`)).json();
    assert.equal(a.total, 5);
  });
});
