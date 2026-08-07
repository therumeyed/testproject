const YOUTUBE_BASE = 'https://www.googleapis.com/youtube/v3';

async function fetchMentions(sinceDate) {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    console.log('[youtube] skipped: YOUTUBE_API_KEY not set');
    return [];
  }

  const query = process.env.SEARCH_QUERY || 'Melbourne Airport';
  const params = new URLSearchParams({
    key: apiKey,
    q: query,
    part: 'snippet',
    type: 'video',
    order: 'date',
    maxResults: '25',
    publishedAfter: sinceDate.toISOString()
  });

  const res = await fetch(`${YOUTUBE_BASE}/search?${params}`);
  if (!res.ok) throw new Error(`YouTube search failed: ${res.status} ${await res.text()}`);

  const data = await res.json();
  return (data.items || []).map((item) => ({
    source: 'youtube',
    external_id: item.id.videoId,
    url: `https://www.youtube.com/watch?v=${item.id.videoId}`,
    title: item.snippet.title,
    snippet: (item.snippet.description || '').slice(0, 500),
    author: item.snippet.channelTitle,
    posted_at: item.snippet.publishedAt,
    raw_data: item
  }));
}

module.exports = { fetchMentions };
