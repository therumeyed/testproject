const { runActor } = require('../apifyClient');

// Overridable in case this actor gets deprecated/renamed -- see README.
const ACTOR_ID = process.env.APIFY_INSTAGRAM_ACTOR_ID || 'instaprism/instagram-hashtag-posts';

function defaultHashtags() {
  const query = process.env.SEARCH_QUERY || 'Melbourne Airport';
  return [query.toLowerCase().replace(/[^a-z0-9]/g, '')];
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
    .filter((d) => !d.publishedAt || new Date(d.publishedAt) >= sinceDate)
    .map((d) => ({
      source: 'instagram_direct',
      external_id: d.postId || d.shortcode || d.url,
      url: d.url,
      title: null,
      snippet: (d.caption || '').slice(0, 500),
      author: d.owner || null,
      posted_at: d.publishedAt || null,
      raw_data: d
    }));
}

module.exports = { fetchMentions };
