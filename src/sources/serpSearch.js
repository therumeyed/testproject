const { runActor } = require('../apifyClient');

// Overridable in case this actor gets deprecated/renamed -- see README.
const ACTOR_ID = process.env.APIFY_GOOGLE_SEARCH_ACTOR_ID || 'apify/google-search-scraper';

function buildGoogleUrl(q) {
  const params = new URLSearchParams({ q, tbs: 'qdr:d', num: '30', gl: 'au' });
  return `https://www.google.com/search?${params}`;
}

// Classify by the result's own domain rather than trying to match it back to
// whichever site:-restricted query produced it -- more robust against
// however the actor echoes the query it ran.
function classifySource(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    if (host.endsWith('facebook.com')) return 'facebook_search';
    if (host.endsWith('instagram.com')) return 'instagram_search';
    if (host.endsWith('linkedin.com')) return 'linkedin_search';
  } catch {
    // malformed URL, fall through to web_search
  }
  return 'web_search';
}

// Only ever surfaces indexed post/page content, never comment threads
// underneath someone else's post -- that data isn't reachable via search indexing.
async function fetchMentions() {
  if (!process.env.APIFY_TOKEN) {
    console.log('[serp] skipped: APIFY_TOKEN not set');
    return [];
  }

  const query = process.env.SEARCH_QUERY || 'Melbourne Airport';
  const rawQueries = [
    `site:facebook.com "${query}"`,
    `site:instagram.com "${query}"`,
    `site:linkedin.com "${query}"`,
    `"${query}"`
  ];

  const items = await runActor(ACTOR_ID, {
    queries: rawQueries.map(buildGoogleUrl),
    countryCode: 'au'
  });

  const results = [];
  for (const item of items || []) {
    for (const r of item.organicResults || []) {
      if (!r.url) continue;
      results.push({
        source: classifySource(r.url),
        external_id: r.url,
        url: r.url,
        title: r.title || null,
        snippet: r.description || null,
        author: null,
        posted_at: null,
        raw_data: r
      });
    }
  }
  return results;
}

module.exports = { fetchMentions };
