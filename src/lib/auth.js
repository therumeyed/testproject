const crypto = require('crypto');

// Lightweight session auth: a shared access password gates sign-in; the
// signed-in email's presence in ADMIN_EMAILS decides role. No external
// session store needed -- swap for real SSO before a wider production
// rollout (see README "Auth model").
const COOKIE_NAME = 'sg_session';
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function secret() {
  return process.env.SESSION_SECRET || 'dev-only-insecure-secret';
}

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verify(token) {
  if (!token || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function isAdminEmail(email) {
  const list = (process.env.ADMIN_EMAILS || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
  return list.includes((email || '').toLowerCase());
}

function createSessionCookie(email) {
  const role = isAdminEmail(email) ? 'admin' : 'standard';
  const token = sign({ email, role, exp: Date.now() + MAX_AGE_MS });
  return { token, role, cookieHeader: `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; Path=/; Max-Age=${Math.floor(MAX_AGE_MS / 1000)}; SameSite=Lax` };
}

function clearCookieHeader() {
  return `${COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`;
}

function requireAuth(req, res, next) {
  const cookies = parseCookies(req);
  const session = verify(cookies[COOKIE_NAME]);
  if (!session) return res.status(401).json({ error: 'not_authenticated' });
  req.user = session;
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'admin_only' });
  next();
}

function getSessionFromRequest(req) {
  const cookies = parseCookies(req);
  return verify(cookies[COOKIE_NAME]);
}

module.exports = { COOKIE_NAME, createSessionCookie, clearCookieHeader, requireAuth, requireAdmin, getSessionFromRequest, isAdminEmail };
