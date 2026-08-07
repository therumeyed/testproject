const SERPAPI_BASE = 'https://serpapi.com/search.json';

function buildQueries(query) {
  return [
    { source: 'facebook_search', q: `site:facebook.com "${query}"` },
    { source: 'instagram_search', q: `site:instagram.com "${query}"` },
    { source: 'linkedin_search', q: `site:linkedin.com "${query}"` },
    { source: 'web_search', q: `"${query}"` }
  ];
}

async function runQuery(apiKey, source, q) {
  const params = new URLSearchParams({
    engine: 'google',
    q,
    api_key: apiKey,
    tbs: 'qdr:d', // restrict to results from the past 24 hours
    num: '30'
  });

  const res = await fetch(`${SERPAPI_BASE}?${params}`);
  if (!res.ok) throw new Error(`SerpApi request failed for ${source}: ${res.status} ${await res.text()}`);

  const data = await res.json();
  // No stable per-result ID from Google -- the URL itself is the dedupe key,
  // which is also what "first instance found on Google search results" means in practice.
  return (data.organic_results || []).map((r) => ({
    source,
    external_id: r.link,
    url: r.link,
    title: r.title || null,
    snippet: r.snippet || null,
    author: null,
    posted_at: null,
    raw_data: r
  }));
}

// This only ever surfaces indexed post/page content, never comment threads
// underneath someone else's post -- that data isn't reachable via search indexing.
async function fetchMentions() {
  const apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) {
    console.log('[serp] skipped: SERPAPI_KEY not set');
    return [];
  }

  const query = process.env.SEARCH_QUERY || 'Melbourne Airport';
  const results = [];
  for (const { source, q } of buildQueries(query)) {
    try {
      results.push(...(await runQuery(apiKey, source, q)));
    } catch (err) {
      console.error(`[serp:${source}] failed:`, err.message);
    }
  }
  return results;
}

module.exports = { fetchMentions };
