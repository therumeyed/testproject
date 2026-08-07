const REDDIT_BASE = 'https://oauth.reddit.com';
const USER_AGENT = 'melair-mentions-dashboard/1.0 (by /u/melair-monitor)';

let tokenCache = { token: null, expiresAt: 0 };

async function getToken() {
  if (tokenCache.token && Date.now() < tokenCache.expiresAt) return tokenCache.token;

  const id = process.env.REDDIT_CLIENT_ID;
  const secret = process.env.REDDIT_CLIENT_SECRET;
  if (!id || !secret) return null;

  const res = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': USER_AGENT
    },
    body: 'grant_type=client_credentials'
  });
  if (!res.ok) throw new Error(`Reddit auth failed: ${res.status} ${await res.text()}`);

  const data = await res.json();
  tokenCache = { token: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000 };
  return tokenCache.token;
}

// Reddit's official API supports full-text search of posts (submissions), not
// comments -- there is no general "search all comment text on Reddit" endpoint
// in the mainline API, so this only finds submissions that mention the query.
async function fetchMentions(sinceDate) {
  const token = await getToken();
  if (!token) {
    console.log('[reddit] skipped: REDDIT_CLIENT_ID/REDDIT_CLIENT_SECRET not set');
    return [];
  }

  const query = process.env.SEARCH_QUERY || 'Melbourne Airport';
  const params = new URLSearchParams({ q: query, sort: 'new', limit: '50' });
  const res = await fetch(`${REDDIT_BASE}/search?${params}`, {
    headers: { Authorization: `Bearer ${token}`, 'User-Agent': USER_AGENT }
  });
  if (!res.ok) throw new Error(`Reddit search failed: ${res.status} ${await res.text()}`);

  const data = await res.json();
  const sinceSec = sinceDate.getTime() / 1000;

  return (data.data?.children || [])
    .map((c) => c.data)
    .filter((d) => d.created_utc >= sinceSec)
    .map((d) => ({
      source: 'reddit',
      external_id: d.id,
      url: `https://www.reddit.com${d.permalink}`,
      title: d.title || null,
      snippet: (d.selftext || '').slice(0, 500),
      author: d.author,
      posted_at: new Date(d.created_utc * 1000).toISOString(),
      raw_data: d
    }));
}

module.exports = { fetchMentions };
