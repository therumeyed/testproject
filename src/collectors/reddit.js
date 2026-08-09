const { runActor } = require('../lib/apifyClient');
const repo = require('../lib/repo');
const { getConfig } = require('../config/seedConfig');
const { containsQuestion, containsPurchaseIntent } = require('../lib/textSignals');

// Field mapping follows trudax/reddit-scraper-lite's output shape (already
// verified working elsewhere in this account's Apify pipelines). RECONFIRM
// query recall against a live run before production (README "Phase 0").
const ACTOR_ID = process.env.APIFY_REDDIT_ACTOR_ID || 'trudax/reddit-scraper-lite';
const MAX_ITEMS = Number(process.env.APIFY_MAX_ITEMS_PER_QUERY) || 60;

function mapPost(item, query) {
  const nativeId = item.id || item.parsedId || item.url;
  if (!nativeId) return null;
  return {
    nativeId: String(nativeId),
    url: item.url,
    contentType: 'text',
    caption: item.title || null,
    transcript: item.body || null,
    hashtags: [],
    mentions: [],
    creator: {
      platformCreatorId: item.username || null,
      handle: item.username || null,
      displayName: item.username || null,
      followerCount: null,
      verified: null
    },
    publishTs: item.createdAt || null,
    subreddit: item.communityName || item.parsedCommunityName || null,
    isPinned: item.isPinned ?? false,
    metrics: {
      // Reddit has no comparable public "view" metric -- score/upvotes and
      // comment count are the discussion-volume signals we store (section 5.5).
      playCount: null,
      likeCount: item.upVotes ?? item.score ?? null,
      commentCount: item.numberOfComments ?? null,
      shareCount: null,
      saveCount: null
    },
    upvoteRatio: item.upVoteRatio ?? null,
    raw: item,
    query
  };
}

async function collect() {
  if (!process.env.APIFY_TOKEN) {
    console.log('[reddit] skipped: APIFY_TOKEN not set');
    return { platform: 'reddit', skipped: true, fetched: 0, new: 0 };
  }

  const runId = await repo.startSourceRun('reddit');
  const queries = await repo.getActiveQueries('reddit');
  const sampling = await getConfig('comment_sampling');
  let fetched = 0;
  let newCount = 0;
  const today = new Date().toISOString().slice(0, 10);

  try {
    for (const q of queries) {
      // Subreddit-monitoring queries get a deeper comment sample (fewer,
      // higher-value sources); keyword search queries get the shallow
      // sample to keep pay-per-result cost bounded (section 5.6).
      const isSubreddit = q.query_type === 'subreddit';
      const startUrls = isSubreddit
        ? [{ url: `https://www.reddit.com/r/${q.query_text}/new/` }]
        : undefined;

      let items;
      try {
        items = await runActor(ACTOR_ID, {
          ...(startUrls ? { startUrls } : { searches: [q.query_text] }),
          maxItems: MAX_ITEMS,
          maxPostCount: MAX_ITEMS,
          maxComments: isSubreddit ? sampling.deep_sample_size : sampling.shallow_sample_size,
          skipComments: false
        });
      } catch (err) {
        console.error(`[reddit] query "${q.query_text}" failed:`, err.message);
        continue;
      }

      const posts = (items || []).filter((d) => !d.parentId);
      const comments = (items || []).filter((d) => d.parentId);

      const postIdByNative = new Map();
      for (const raw of posts) {
        const mapped = mapPost(raw, q.query_text);
        if (!mapped) continue;
        fetched++;

        if (await repo.isExcludedText(`${mapped.caption} ${mapped.transcript}`)) continue;

        const rawItemId = await repo.upsertRawItem('reddit', mapped.nativeId, runId, mapped.raw);
        const creatorId = mapped.creator.platformCreatorId
          ? await repo.upsertCreator('reddit', mapped.creator)
          : null;
        const { id: postId, isNew } = await repo.upsertPost({
          platform: 'reddit', nativeId: mapped.nativeId, rawSocialItemId: rawItemId,
          url: mapped.url, contentType: mapped.contentType, caption: mapped.caption,
          transcript: mapped.transcript, creatorId, publishTs: mapped.publishTs,
          isPinned: mapped.isPinned, locationCountry: null
        });
        if (isNew) newCount++;
        await repo.recordQueryMatch(postId, q.id);
        await repo.upsertMetricSnapshot(postId, today, mapped.metrics);
        postIdByNative.set(raw.id, postId);
        postIdByNative.set(raw.parsedId, postId);
      }

      for (const c of comments) {
        const parentPostId = postIdByNative.get(c.parentId) || null;
        const body = c.body || '';
        await repo.upsertComment({
          platform: 'reddit',
          nativeCommentId: String(c.id),
          postId: parentPostId,
          subreddit: c.communityName || c.parsedCommunityName || null,
          author: c.username || null,
          body,
          score: c.upVotes ?? c.score ?? null,
          postedTs: c.createdAt || null,
          containsQuestion: containsQuestion(body),
          containsPurchaseIntent: containsPurchaseIntent(body)
        });
      }
    }

    await repo.finishSourceRun(runId, { status: 'success', itemsFetched: fetched, itemsNew: newCount });
  } catch (err) {
    await repo.finishSourceRun(runId, { status: 'error', itemsFetched: fetched, itemsNew: newCount, errorMessage: err.message });
    throw err;
  }

  return { platform: 'reddit', skipped: false, fetched, new: newCount };
}

module.exports = { collect };
