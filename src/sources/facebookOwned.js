const GRAPH_BASE = 'https://graph.facebook.com/v21.0';

// Only reaches comments on posts from a Page MelAir administers and has
// granted this app access to -- never comments on other people's/Pages' posts.
async function fetchMentions(sinceDate) {
  const pageId = process.env.FB_PAGE_ID;
  const token = process.env.FB_PAGE_ACCESS_TOKEN;
  if (!pageId || !token) {
    console.log('[facebook_own] skipped: FB_PAGE_ID/FB_PAGE_ACCESS_TOKEN not set');
    return [];
  }

  const sinceUnix = Math.floor(sinceDate.getTime() / 1000);
  const postsRes = await fetch(
    `${GRAPH_BASE}/${pageId}/posts?since=${sinceUnix}&fields=id,permalink_url&access_token=${token}`
  );
  if (!postsRes.ok) throw new Error(`Facebook posts fetch failed: ${postsRes.status} ${await postsRes.text()}`);
  const postsData = await postsRes.json();

  const mentions = [];
  for (const post of postsData.data || []) {
    const commentsRes = await fetch(
      `${GRAPH_BASE}/${post.id}/comments?since=${sinceUnix}&fields=id,message,from,created_time,permalink_url&access_token=${token}`
    );
    if (!commentsRes.ok) {
      console.error(`[facebook_own] comments fetch failed for ${post.id}: ${commentsRes.status}`);
      continue;
    }
    const commentsData = await commentsRes.json();
    for (const c of commentsData.data || []) {
      mentions.push({
        source: 'facebook_own',
        external_id: c.id,
        url: c.permalink_url || post.permalink_url,
        title: null,
        snippet: (c.message || '').slice(0, 500),
        author: c.from?.name || null,
        posted_at: c.created_time,
        raw_data: c
      });
    }
  }
  return mentions;
}

module.exports = { fetchMentions };
