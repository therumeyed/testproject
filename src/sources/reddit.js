const { runActor } = require('../apifyClient');

// Overridable in case this actor gets deprecated/renamed -- see README.
const ACTOR_ID = process.env.APIFY_REDDIT_ACTOR_ID || 'trudax/reddit-scraper-lite';

function subreddits() {
  const raw = process.env.APIFY_REDDIT_SUBREDDITS || 'melbourne,australia';
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function subredditSearchUrl(subreddit, query) {
  const params = new URLSearchParams({ q: query, sort: 'new', t: 'day', restrict_sr: '1' });
  return `https://www.reddit.com/r/${subreddit}/search/?${params}`;
}

// Restricted to specific communities (APIFY_REDDIT_SUBREDDITS) instead of a
// site-wide search -- fewer, more relevant results and lower cost, since this
// actor bills pay-per-result (~$3.40/1,000 as of writing). Reddit search also
// only finds posts (submissions), not arbitrary comment text.
async function fetchMentions(sinceDate) {
  if (!process.env.APIFY_TOKEN) {
    console.log('[reddit] skipped: APIFY_TOKEN not set');
    return [];
  }

  const query = process.env.SEARCH_QUERY || 'Melbourne Airport';
  const startUrls = subreddits().map((sub) => ({ url: subredditSearchUrl(sub, query) }));

  const items = await runActor(ACTOR_ID, {
    startUrls,
    sort: 'new',
    time: 'day',
    maxItems: 40,
    maxPostCount: 20,
    maxComments: 0,
    skipComments: true
  });

  return (items || [])
    .filter((d) => !d.parentId) // comment objects carry a parentId, posts don't
    .filter((d) => !d.createdAt || new Date(d.createdAt) >= sinceDate)
    .map((d) => ({
      source: 'reddit',
      external_id: d.id || d.parsedId || d.url,
      url: d.url,
      title: d.title || null,
      snippet: (d.body || '').slice(0, 500),
      author: d.username || null,
      posted_at: d.createdAt || null,
      raw_data: d
    }));
}

module.exports = { fetchMentions };
