// End-to-end test for GET /api/word-cloud against a real server + DB:
// confirms it respects the same filters as /api/mentions and /api/analytics
// (shared parseFilters/buildWhere), and that domain/generic stopwords are
// excluded from what actually comes back over HTTP, not just in the pure
// unit tests for computeWordFrequencies itself. Gated on TEST_DATABASE_URL
// like the other DB-backed suites, so `npm test` never touches a real DB.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const skip = !TEST_DATABASE_URL ? 'set TEST_DATABASE_URL to a scratch database to run this suite' : false;
const PORT = process.env.WORD_CLOUD_TEST_PORT || 3996;
const BASE = `http://localhost:${PORT}`;

describe('GET /api/word-cloud (DB-backed, real server)', { skip }, () => {
  let serverProcess;
  let pool;

  before(async () => {
    const { Pool } = require('pg');
    pool = new Pool({ connectionString: TEST_DATABASE_URL });

    serverProcess = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
      env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL, PORT: String(PORT) },
      stdio: 'ignore'
    });
    for (let i = 0; i < 50; i++) {
      try {
        const res = await fetch(`${BASE}/health`);
        if (res.ok) break;
      } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 200));
    }
    await pool.query('TRUNCATE TABLE mentions RESTART IDENTITY');

    const now = new Date();
    await pool.query(
      `INSERT INTO mentions (source, external_id, title, snippet, category, sentiment, relevant, first_seen_at)
       VALUES
       ('google_reviews','wc1','Melbourne Airport — 1★','Parking fees are expensive and confusing.','parking','negative',true,$1),
       ('reddit','wc2','','Staff were rude and the queue was confusing.','terminal_experience','negative',true,$1),
       ('reddit','wc3','','Great staff, friendly and helpful experience.','terminal_experience','positive',true,$1)`,
      [now]
    );
  });

  after(async () => {
    await pool.query('TRUNCATE TABLE mentions RESTART IDENTITY');
    await pool.end();
    serverProcess.kill();
  });

  test('returns word frequencies excluding domain/generic stopwords', async () => {
    const data = await (await fetch(`${BASE}/api/word-cloud`)).json();
    assert.equal(data.total, 3);
    const words = data.words.map((w) => w.word);
    assert.ok(words.includes('confusing'));
    assert.ok(words.includes('rude'));
    assert.ok(words.includes('staff'));
    assert.ok(!words.includes('melbourne'));
    assert.ok(!words.includes('airport'));
    assert.ok(!words.includes('parking'));
    const confusing = data.words.find((w) => w.word === 'confusing');
    assert.equal(confusing.count, 2);
  });

  test('respects the same category filter as /api/mentions and /api/analytics', async () => {
    const data = await (await fetch(`${BASE}/api/word-cloud?category=parking`)).json();
    assert.equal(data.total, 1);
    const words = data.words.map((w) => w.word);
    assert.ok(words.includes('expensive'));
    assert.ok(!words.includes('rude'), 'rude only appears in a terminal_experience mention, not parking');
  });
});
