const { runActor } = require('../apifyClient');

// Overridable in case this actor gets deprecated/renamed -- see README.
const ACTOR_ID = process.env.APIFY_REDDIT_ACTOR_ID || 'trudax/reddit-scraper';

// Reddit search finds posts (submissions), not arbitrary comment text --
// there's no full-text "search all comments" capability here either.
async function fetchMentions(sinceDate) {
  if (!process.env.APIFY_TOKEN) {
    console.log('[reddit] skipped: APIFY_TOKEN not set');
    return [];
  }

  const query = process.env.SEARCH_QUERY || 'Melbourne Airport';
  const items = await runActor(ACTOR_ID, {
    searches: [query],
    sort: 'New',
    time: 'day',
    maxItems: 50,
    maxPostCount: 50,
    maxComments: 0
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
