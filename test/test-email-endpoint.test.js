// Gating tests for POST /admin/test-email -- sends a sample urgent alert +
// digest so formatting can be checked in a real inbox. Doesn't touch the
// database at all, but booting the server (even just to test its auth
// gates) still needs a working DB connection for initSchemaWithRetry, so
// this is gated on TEST_DATABASE_URL like the other DB-backed suites.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const skip = !TEST_DATABASE_URL ? 'set TEST_DATABASE_URL to a scratch database to run this suite' : false;
const PORT = process.env.TEST_EMAIL_TEST_PORT || 3997;
const BASE = `http://localhost:${PORT}`;
const ADMIN_TOKEN = 'test-admin-token';

describe('POST /admin/test-email gating (DB-backed, real server)', { skip }, () => {
  let serverProcess;

  before(async () => {
    serverProcess = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
      // No RESEND_API_KEY/ALERT_EMAIL_TO -- this suite only checks the
      // route's gates, never actually sends an email.
      env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL, PORT: String(PORT), ADMIN_TOKEN, RESEND_API_KEY: '', ALERT_EMAIL_TO: '' },
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
    const res = await fetch(`${BASE}/admin/test-email`, { method: 'POST' });
    assert.equal(res.status, 403);
  });

  test('with a valid token but no RESEND_API_KEY, fails fast with a clear error instead of silently no-op-ing', async () => {
    const res = await fetch(`${BASE}/admin/test-email`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` }
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.match(data.error, /RESEND_API_KEY/);
  });
});
