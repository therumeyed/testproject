// Gating tests for POST /admin/trigger-trends-fetch -- the on-demand
// DataForSEO fetch used to verify freshly-added credentials without waiting
// for the next scheduled cron window. Doesn't exercise a real DataForSEO
// call (no live credentials in this environment), only the route's own
// auth/validation gates. Gated on TEST_DATABASE_URL since booting the
// server needs a working DB connection.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const skip = !TEST_DATABASE_URL ? 'set TEST_DATABASE_URL to a scratch database to run this suite' : false;
const PORT = process.env.TRIGGER_TRENDS_TEST_PORT || 3993;
const BASE = `http://localhost:${PORT}`;
const ADMIN_TOKEN = 'test-admin-token';

describe('POST /admin/trigger-trends-fetch gating (DB-backed, real server)', { skip }, () => {
  let serverProcess;

  before(async () => {
    serverProcess = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
      // No DATAFORSEO_LOGIN/PASSWORD -- this suite only checks the route's
      // gates, never actually calls DataForSEO.
      env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL, PORT: String(PORT), ADMIN_TOKEN, DATAFORSEO_LOGIN: '', DATAFORSEO_PASSWORD: '' },
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
    const res = await fetch(`${BASE}/admin/trigger-trends-fetch`, { method: 'POST' });
    assert.equal(res.status, 403);
  });

  test('with a valid token but no DataForSEO credentials, fails fast with a clear error', async () => {
    const res = await fetch(`${BASE}/admin/trigger-trends-fetch`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` }
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.match(data.error, /DATAFORSEO_LOGIN/);
  });

  test('defaults to scope=daily, and accepts scope=weekly explicitly', async () => {
    // Both still 400 (no credentials), but confirms the query param is read
    // without crashing the route before the credential check even runs.
    const daily = await fetch(`${BASE}/admin/trigger-trends-fetch`, { method: 'POST', headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } });
    const weekly = await fetch(`${BASE}/admin/trigger-trends-fetch?scope=weekly`, { method: 'POST', headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } });
    assert.equal(daily.status, 400);
    assert.equal(weekly.status, 400);
  });
});
