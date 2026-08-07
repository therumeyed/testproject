const GRAPH_BASE = 'https://graph.facebook.com/v21.0';

// Only reaches comments on media from an Instagram Business/Creator account
// MelAir owns and has connected -- never comments on other accounts' posts.
async function fetchMentions(sinceDate) {
  const igUserId = process.env.IG_BUSINESS_ACCOUNT_ID;
  const token = process.env.IG_ACCESS_TOKEN;
  if (!igUserId || !token) {
    console.log('[instagram_own] skipped: IG_BUSINESS_ACCOUNT_ID/IG_ACCESS_TOKEN not set');
    return [];
  }

  const sinceUnix = Math.floor(sinceDate.getTime() / 1000);
  const mediaRes = await fetch(
    `${GRAPH_BASE}/${igUserId}/media?since=${sinceUnix}&fields=id,permalink,timestamp&access_token=${token}`
  );
  if (!mediaRes.ok) throw new Error(`Instagram media fetch failed: ${mediaRes.status} ${await mediaRes.text()}`);
  const mediaData = await mediaRes.json();

  const mentions = [];
  for (const media of mediaData.data || []) {
    const commentsRes = await fetch(
      `${GRAPH_BASE}/${media.id}/comments?fields=id,text,username,timestamp&access_token=${token}`
    );
    if (!commentsRes.ok) {
      console.error(`[instagram_own] comments fetch failed for ${media.id}: ${commentsRes.status}`);
      continue;
    }
    const commentsData = await commentsRes.json();
    for (const c of commentsData.data || []) {
      if (new Date(c.timestamp) < sinceDate) continue;
      mentions.push({
        source: 'instagram_own',
        external_id: c.id,
        url: media.permalink,
        title: null,
        snippet: (c.text || '').slice(0, 500),
        author: c.username || null,
        posted_at: c.timestamp,
        raw_data: c
      });
    }
  }
  return mentions;
}

module.exports = { fetchMentions };
