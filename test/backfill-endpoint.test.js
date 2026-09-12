// Gating tests for POST /admin/backfill-categories -- the HTTP-triggerable
// version of `npm run backfill-categories`, for classifying mentions with no
// category at all (category IS NULL) from the deployed dashboard when shell
// access isn't available. The classify-and-write path itself reuses
// getMentionsNeedingCategoryBackfill/updateCategory, already covered end to
// end by db-category.test.js and sentiment.test.js -- this only checks the
// route's own auth/validation gating, which doesn't require a live
// ANTHROPIC_API_KEY to exercise. Gated on TEST_DATABASE_URL like the other
// DB-backed suites.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const skip = !TEST_DATABASE_URL ? 'set TEST_DATABASE_URL to a scratch database to run this suite' : false;
const PORT = process.env.BACKFILL_TEST_PORT || 3998;
const BASE = `http://localhost:${PORT}`;
const ADMIN_TOKEN = 'test-admin-token';

describe('POST /admin/backfill-categories gating (DB-backed, real server)', { skip }, () => {
  let serverProcess;

  before(async () => {
    serverProcess = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
      // Deliberately no ANTHROPIC_API_KEY -- this suite only exercises the
      // route's auth/validation gates, which must both run before any
      // classification is attempted.
      env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL, PORT: String(PORT), ADMIN_TOKEN, ANTHROPIC_API_KEY: '' },
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

  after(() => {
    serverProcess.kill();
  });

  test('rejects without an admin token', async () => {
    const res = await fetch(`${BASE}/admin/backfill-categories`, { method: 'POST' });
    assert.equal(res.status, 403);
  });

  test('rejects with the wrong admin token', async () => {
    const res = await fetch(`${BASE}/admin/backfill-categories`, {
      method: 'POST',
      headers: { Authorization: 'Bearer not-the-real-token' }
    });
    assert.equal(res.status, 403);
  });

  test('with a valid token but no ANTHROPIC_API_KEY, fails fast with a clear error before touching any rows', async () => {
    const res = await fetch(`${BASE}/admin/backfill-categories`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ afterId: 0 })
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.match(data.error, /ANTHROPIC_API_KEY/);
  });
});
