// DB-backed tests for manual category override preservation, gated on
// TEST_DATABASE_URL (never DATABASE_URL) so `npm test` can never truncate a
// real/production database just because it happens to be configured in the
// environment -- these tests are skipped entirely unless a dedicated test
// database is explicitly provided.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const skip = !TEST_DATABASE_URL ? 'set TEST_DATABASE_URL to a scratch database to run this suite' : false;

describe('manual category override preservation (DB-backed)', { skip }, () => {
  let db;

  before(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    db = require('../src/db');
    await db.initSchema();
    await db.pool.query('TRUNCATE TABLE mentions RESTART IDENTITY');
  });

  after(async () => {
    await db.pool.query('TRUNCATE TABLE mentions RESTART IDENTITY');
    await db.pool.end();
  });

  test('setManualCategory marks category_source=manual and clears confidence', async () => {
    const [{ id }] = (await db.insertMentions([{ source: 'reddit', external_id: 'm1', title: 't', snippet: 's' }]));
    await db.setManualCategory(id, 'parking');
    const { rows } = await db.pool.query('SELECT category, category_source, category_confidence FROM mentions WHERE id=$1', [id]);
    assert.equal(rows[0].category, 'parking');
    assert.equal(rows[0].category_source, 'manual');
    assert.equal(rows[0].category_confidence, null);
  });

  test('a manual override is never overwritten by the resumable backfill query', async () => {
    const [{ id }] = await db.insertMentions([{ source: 'reddit', external_id: 'm2', title: 't', snippet: 's' }]);
    await db.setManualCategory(id, 'taxi_rideshare');
    // getMentionsNeedingCategoryBackfill only looks at category IS NULL, so a
    // manually-categorized row (category is now non-null) must not appear.
    const backfillCandidates = await db.getMentionsNeedingCategoryBackfill(50, 0);
    assert.ok(!backfillCandidates.some((r) => r.id === id), 'manually-categorized row must not be a backfill candidate');
  });

  test('a manual override to "unclassified" is excluded from reclassify-unclassified', async () => {
    const [{ id }] = await db.insertMentions([{ source: 'reddit', external_id: 'm3', title: 't', snippet: 's' }]);
    await db.setManualCategory(id, 'unclassified');
    const candidates = await db.getUnclassifiedMentions(50);
    assert.ok(!candidates.some((r) => r.id === id), 'manually-set unclassified row must be excluded from auto-reclassification');
  });

  test('an AI-classified "unclassified" row (not manual) IS picked up for reclassification', async () => {
    const [{ id }] = await db.insertMentions([{ source: 'reddit', external_id: 'm4', title: 't', snippet: 's' }]);
    await db.updateCategory(id, { category: 'unclassified', category_confidence: 0.4 });
    const candidates = await db.getUnclassifiedMentions(50);
    assert.ok(candidates.some((r) => r.id === id), 'AI-classified unclassified row should remain eligible for reclassification');
  });

  test('updateCategory (the backfill write path) never touches sentiment/severity/relevant', async () => {
    const [{ id }] = await db.insertMentions([{ source: 'reddit', external_id: 'm5', title: 't', snippet: 's' }]);
    await db.updateSentiment(id, { sentiment: 'negative', severity: 'high', reason: 'already reviewed', relevant: true, category: null, category_confidence: null });
    await db.updateCategory(id, { category: 'general_airport', category_confidence: 0.85 });
    const { rows } = await db.pool.query('SELECT sentiment, severity, sentiment_reason, relevant, category FROM mentions WHERE id=$1', [id]);
    assert.equal(rows[0].sentiment, 'negative');
    assert.equal(rows[0].severity, 'high');
    assert.equal(rows[0].sentiment_reason, 'already reviewed');
    assert.equal(rows[0].relevant, true);
    assert.equal(rows[0].category, 'general_airport');
  });

  test('the resumable backfill cursor advances past a page even if some rows in it stay unclassifiable', async () => {
    const inserted = await db.insertMentions([
      { source: 'reddit', external_id: 'c1', title: 't', snippet: 's' },
      { source: 'reddit', external_id: 'c2', title: 't', snippet: 's' },
      { source: 'reddit', external_id: 'c3', title: 't', snippet: 's' }
    ]);
    const ids = inserted.map((r) => r.id).sort((a, b) => a - b);
    const page = await db.getMentionsNeedingCategoryBackfill(2, 0);
    assert.equal(page.length, 2);
    assert.deepEqual(page.map((r) => r.id), [ids[0], ids[1]]);
    // simulate: only the first of the two classified successfully, the
    // second stayed NULL -- a naive "WHERE category IS NULL" requery would
    // return the same stuck row forever without the explicit cursor
    await db.updateCategory(ids[0], { category: 'parking', category_confidence: 0.9 });
    const nextPage = await db.getMentionsNeedingCategoryBackfill(2, ids[1]);
    assert.deepEqual(nextPage.map((r) => r.id), [ids[2]]);
  });
});
