const { runActor } = require('../apifyClient');
const { matchesPhrase } = require('../textMatch');

// Overridable in case this actor gets deprecated/renamed -- see README.
const ACTOR_ID = process.env.APIFY_FACEBOOK_ACTOR_ID || 'scrapeforge/facebook-search-posts';

function toDateOnly(date) {
  return date.toISOString().slice(0, 10);
}

function parseTimestamp(ts) {
  if (!ts) return null;
  const num = Number(ts);
  if (!Number.isFinite(num)) return null;
  return new Date(num < 1e12 ? num * 1000 : num).toISOString();
}

// Direct phrase search across public Facebook posts (logged-out, no page
// ownership required) -- separate from the Google-indexed `facebook_search`
// source in serpSearch.js, which only catches what Google has crawled.
async function fetchMentions(sinceDate) {
  if (!process.env.APIFY_TOKEN) {
    console.log('[facebook_direct] skipped: APIFY_TOKEN not set');
    return [];
  }

  const query = process.env.SEARCH_QUERY || 'Melbourne Airport';
  const items = await runActor(ACTOR_ID, {
    query,
    search_type: 'posts',
    max_results: 50,
    start_date: toDateOnly(sinceDate),
    recent_posts: true
  });

  return (items || [])
    .map((d) => ({ ...d, posted_at: parseTimestamp(d.timestamp) }))
    .filter((d) => !d.posted_at || new Date(d.posted_at) >= sinceDate)
    .filter((d) => matchesPhrase(d.message, query))
    .map((d) => ({
      source: 'facebook_direct',
      external_id: d.post_id || d.url,
      url: d.url,
      title: null,
      snippet: (d.message || '').slice(0, 500),
      author: d.author?.name || null,
      posted_at: d.posted_at,
      raw_data: d
    }));
}

module.exports = { fetchMentions };
