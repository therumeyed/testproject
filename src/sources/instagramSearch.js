const { runActor } = require('../apifyClient');

// Overridable in case this actor gets deprecated/renamed -- see README.
const ACTOR_ID = process.env.APIFY_INSTAGRAM_ACTOR_ID || 'instaprism/instagram-hashtag-posts';

function defaultHashtags() {
  const query = process.env.SEARCH_QUERY || 'Melbourne Airport';
  return [query.toLowerCase().replace(/[^a-z0-9]/g, '')];
}

// Actor docs claim ISO 8601, but live output is "DD.MM.YYYY_HH.MM"
// (e.g. "07.08.2026_18.23") -- Date() can't parse that directly.
function parsePublishedAt(raw) {
  const match = /^(\d{2})\.(\d{2})\.(\d{4})_(\d{2})\.(\d{2})$/.exec(raw || '');
  if (!match) return null;
  const [, dd, mm, yyyy, hh, mi] = match;
  const date = new Date(`${yyyy}-${mm}-${dd}T${hh}:${mi}:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

// Instagram has no free-text post search -- hashtag search is the closest
// real capability, so this only catches posts tagged with the configured
// hashtag(s), not every post that merely mentions the airport in its caption.
async function fetchMentions(sinceDate) {
  if (!process.env.APIFY_TOKEN) {
    console.log('[instagram_direct] skipped: APIFY_TOKEN not set');
    return [];
  }

  const hashtags = process.env.APIFY_INSTAGRAM_HASHTAGS
    ? process.env.APIFY_INSTAGRAM_HASHTAGS.split(',').map((h) => h.trim()).filter(Boolean)
    : defaultHashtags();

  const items = await runActor(ACTOR_ID, {
    hashtags,
    limit: 50,
    sortBy: 'recent'
  });

  return (items || [])
    .map((d) => ({ ...d, parsedPublishedAt: parsePublishedAt(d.publishedAt) }))
    .filter((d) => !d.parsedPublishedAt || d.parsedPublishedAt >= sinceDate)
    .map((d) => ({
      source: 'instagram_direct',
      external_id: d.postId || d.url,
      url: d.url,
      title: null,
      snippet: (d.caption || '').slice(0, 500),
      // The actor only exposes a numeric author ID, not a readable username.
      author: d.authorId || null,
      posted_at: d.parsedPublishedAt ? d.parsedPublishedAt.toISOString() : null,
      raw_data: d
    }));
}

module.exports = { fetchMentions };
