// No login gate: this tool is open to anyone with the URL, by request, for
// use with a small trusted internal team. There is no per-user account
// system, so every request is attributed to a single fixed identity purely
// so the audit log and workflow-action history have an email to record --
// this is NOT access control. Re-introduce real per-user auth (e.g. SSO)
// before sharing the link more widely, since anyone with it currently has
// full admin access (taxonomy, score weights, merge/suppress trends, etc.).
function attachIdentity(req, res, next) {
  const email = (process.env.DEFAULT_USER_EMAIL || (process.env.ADMIN_EMAILS || '').split(',')[0] || 'team@sportsgirl.com.au').trim();
  req.user = { email, role: 'admin' };
  next();
}

module.exports = { attachIdentity };
