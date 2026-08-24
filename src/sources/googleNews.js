const { runActor } = require('../apifyClient');
const { matchesPhrase } = require('../textMatch');

// Overridable in case this actor gets deprecated/renamed -- see README.
const ACTOR_ID = process.env.APIFY_GOOGLE_NEWS_ACTOR_ID || 'automation-lab/google-news-scraper';

// Dedicated Google News actor (built on Google News' RSS feeds) -- the
// general web-search actor can't parse Google's News tab or news.google.com
// at all (tested live: empty results / query treated as literal text), so
// this needs its own actor rather than reusing serpSearch.js's.
async function fetchMentions(sinceDate) {
  if (!process.env.APIFY_TOKEN) {
    console.log('[news_search] skipped: APIFY_TOKEN not set');
    return [];
  }

  const query = process.env.SEARCH_QUERY || 'Melbourne Airport';
  const items = await runActor(ACTOR_ID, {
    queries: [`"${query}"`],
    country: 'AU',
    language: 'en',
    maxArticles: 50
  });

  return (items || [])
    .filter((d) => !d.publishedAt || new Date(d.publishedAt) >= sinceDate)
    .filter((d) => matchesPhrase(`${d.title || ''} ${d.description || ''}`, query))
    .map((d) => ({
      source: 'news_search',
      external_id: d.url,
      url: d.url,
      title: d.title || null,
      snippet: (d.description || '').slice(0, 500),
      author: d.source || null,
      posted_at: d.publishedAt || null,
      raw_data: d
    }));
}

module.exports = { fetchMentions };
