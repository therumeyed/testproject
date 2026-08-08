const RESEND_API_BASE = 'https://api.resend.com/emails';

// Resend's sandbox sender (onboarding@resend.dev) only delivers to the email
// address the account signed up with, until a domain is verified -- see
// README before assuming a test send to a new address will land.
async function sendEmail({ subject, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.log('[email] skipped: RESEND_API_KEY not set');
    return;
  }

  const to = (process.env.ALERT_EMAIL_TO || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (to.length === 0) {
    console.log('[email] skipped: ALERT_EMAIL_TO not set');
    return;
  }

  const from = process.env.EMAIL_FROM || 'onboarding@resend.dev';
  const res = await fetch(RESEND_API_BASE, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ from, to, subject, html })
  });
  if (!res.ok) throw new Error(`Resend send failed: ${res.status} ${await res.text()}`);
  return res.json();
}

module.exports = { sendEmail };
