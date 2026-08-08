const { runActor } = require('../apifyClient');
const { matchesPhrase } = require('../textMatch');

// Overridable in case this actor gets deprecated/renamed -- see README.
const ACTOR_ID = process.env.APIFY_REDDIT_ACTOR_ID || 'trudax/reddit-scraper-lite';

function subreddits() {
  const raw = process.env.APIFY_REDDIT_SUBREDDITS || 'melbourne,australia';
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

// Scoped to specific communities (APIFY_REDDIT_SUBREDDITS) rather than a
// site-wide search -- fewer, more relevant results and lower cost on this
// pay-per-result actor (~$3.40/1,000 as of writing). Pulls each subreddit's
// newest posts and filters by keyword locally -- tested against this actor:
// its /r/x/search/?q=... URL parsing returns nothing reliably, only plain
// listing/post/user page URLs (e.g. /r/x/new/) actually work.
async function fetchMentions(sinceDate) {
  if (!process.env.APIFY_TOKEN) {
    console.log('[reddit] skipped: APIFY_TOKEN not set');
    return [];
  }

  const query = process.env.SEARCH_QUERY || 'Melbourne Airport';
  const startUrls = subreddits().map((sub) => ({ url: `https://www.reddit.com/r/${sub}/new/` }));

  const items = await runActor(ACTOR_ID, {
    startUrls,
    maxItems: 60,
    maxPostCount: 30,
    maxComments: 0,
    skipComments: true
  });

  return (items || [])
    .filter((d) => !d.parentId) // comment objects carry a parentId, posts don't
    .filter((d) => !d.createdAt || new Date(d.createdAt) >= sinceDate)
    .filter((d) => matchesPhrase(`${d.title || ''} ${d.body || ''}`, query))
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
