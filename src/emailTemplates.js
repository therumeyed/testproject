// Renders the HTML for the two alert emails (src/ingest.js sends whatever
// this returns via src/email.js). Table-based layout with every style
// inlined -- not because it's elegant, but because Outlook desktop's
// rendering engine ignores <style> blocks and modern CSS (flexbox, grid,
// border-radius on some versions), so this is the only markup pattern that
// reliably survives across Gmail, Apple Mail and Outlook alike.
//
// Colors mirror the dashboard's own palette (public/index.html's CSS
// variables and public/app.js's CATEGORY_META) so the emails read as the
// same product, not a bolted-on notification.
const { CATEGORIES } = require('./categories');

const NAVY = '#071d49';
const BLUE = '#1467e8';
const BG = '#f4f7fb';
const LINE = '#dfe5ee';
const INK = '#162033';
const MUTED = '#68758a';
const RED_BG = '#ffeded';
const RED_FG = '#ad2f2f';
const RED = '#c43d3d';

const SEVERITY_META = {
  high: { label: 'High severity', bg: RED_BG, fg: RED_FG },
  medium: { label: 'Medium severity', bg: '#fff4e5', fg: '#92400e' },
  low: { label: 'Low severity', bg: '#eef1f5', fg: '#556174' }
};

const CATEGORY_COLORS = {
  parking: { bg: '#eaf3ff', fg: '#145bbb' },
  pickup_dropoff: { bg: '#fff1e5', fg: '#995412' },
  taxi_rideshare: { bg: '#f0ecff', fg: '#6145c3' },
  public_transport: { bg: '#e6f7f5', fg: '#0f7d72' },
  terminal_experience: { bg: '#fdeef0', fg: '#a3355a' },
  general_airport: { bg: '#edf7ef', fg: '#39734a' },
  unclassified: { bg: '#eef1f5', fg: '#556174' }
};
const CATEGORY_LABELS = Object.fromEntries(CATEGORIES.map((c) => [c.value, c.label]));

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function chip(label, bg, fg) {
  return `<span style="display:inline-block;background:${bg};color:${fg};font-size:10px;font-weight:700;letter-spacing:.03em;text-transform:uppercase;padding:3px 8px;border-radius:999px;margin:0 6px 6px 0;">${escapeHtml(label)}</span>`;
}

function sourceLabel(source) {
  return String(source || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function mentionCardHtml(m) {
  const title = escapeHtml(m.title || sourceLabel(m.source));
  const snippet = escapeHtml((m.snippet || '').slice(0, 300));
  const severity = m.severity ? SEVERITY_META[m.severity] : null;
  const category = CATEGORY_COLORS[m.category] || null;
  const chips = [
    chip(sourceLabel(m.source), '#eef1f5', MUTED),
    severity ? chip(severity.label, severity.bg, severity.fg) : '',
    category ? chip(CATEGORY_LABELS[m.category] || m.category, category.bg, category.fg) : ''
  ].join('');
  const heading = m.url
    ? `<a href="${escapeHtml(m.url)}" style="color:${NAVY};text-decoration:none;">${title}</a>`
    : title;
  const reasonRow = m.reason
    ? `<tr><td style="padding-top:6px;padding-bottom:16px;font-size:12px;line-height:1.5;color:${MUTED};"><strong style="color:#556174;">Why:</strong> ${escapeHtml(m.reason)}</td></tr>`
    : '';

  return `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-bottom:1px solid #edf1f6;">
    <tr><td style="padding:16px 0 0;">${chips}</td></tr>
    <tr><td style="font-size:14px;font-weight:650;color:${NAVY};padding-top:2px;line-height:1.4;">${heading}</td></tr>
    <tr><td style="font-size:13px;line-height:1.5;color:#3c4757;padding-top:4px;padding-bottom:${reasonRow ? '0' : '16px'};">${snippet}</td></tr>
    ${reasonRow}
  </table>`;
}

function wrapEmail({ accentColor, kicker, title, subtitle, bodyHtml }) {
  return `<!doctype html>
<html>
<body style="margin:0;padding:0;background:${BG};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BG};padding:24px 0;">
    <tr>
      <td align="center">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:14px;border:1px solid ${LINE};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
          <tr>
            <td style="background:${accentColor};padding:24px 28px;border-radius:14px 14px 0 0;">
              <div style="color:rgba(255,255,255,.8);font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;">${escapeHtml(kicker)}</div>
              <div style="color:#ffffff;font-size:20px;font-weight:700;margin-top:6px;">${escapeHtml(title)}</div>
              <div style="color:rgba(255,255,255,.85);font-size:13px;margin-top:6px;line-height:1.5;">${escapeHtml(subtitle)}</div>
            </td>
          </tr>
          <tr>
            <td style="padding:8px 28px 4px;color:${INK};">
              ${bodyHtml}
            </td>
          </tr>
          <tr>
            <td style="padding:20px 28px 28px;">
              <a href="https://melairmentions.brandassistant.app/" style="display:inline-block;background:${BLUE};color:#ffffff;text-decoration:none;font-size:13px;font-weight:600;padding:10px 18px;border-radius:8px;">Open dashboard &rarr;</a>
            </td>
          </tr>
          <tr>
            <td style="padding:14px 28px;background:#f8fafc;border-top:1px solid ${LINE};border-radius:0 0 14px 14px;color:${MUTED};font-size:11px;">
              Melbourne Airport mentions tracker &mdash; automated notification
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function renderUrgentAlert(mentions) {
  const n = mentions.length;
  return {
    subject: `⚠️ ${n} urgent negative mention${n > 1 ? 's' : ''} — Melbourne Airport`,
    html: wrapEmail({
      accentColor: RED,
      kicker: 'Urgent alert',
      title: `${n} high-severity negative mention${n > 1 ? 's' : ''} found`,
      subtitle: "Found in today's Melbourne Airport mentions run. Recommend reviewing and responding directly.",
      bodyHtml: mentions.map(mentionCardHtml).join('')
    })
  };
}

function renderDailyDigest(mentions) {
  const n = mentions.length;
  const bodyHtml = n === 0
    ? `<p style="font-size:13px;color:${MUTED};padding:16px 0;">Nothing to review — check back tomorrow.</p>`
    : mentions.map(mentionCardHtml).join('');
  return {
    subject: `Daily negative mentions digest — ${n} found`,
    html: wrapEmail({
      accentColor: NAVY,
      kicker: 'Daily digest',
      title: n === 0 ? 'All quiet today' : `${n} negative mention${n > 1 ? 's' : ''} found today`,
      subtitle: n === 0
        ? "No negative mentions were found across today's checks."
        : "Across all of today's checks, all sources combined.",
      bodyHtml
    })
  };
}

module.exports = { renderUrgentAlert, renderDailyDigest };
