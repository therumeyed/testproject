const { runActor } = require('../lib/apifyClient');
const repo = require('../lib/repo');
const runStatus = require('../lib/runStatus');

// Field mapping follows apify/instagram-scraper's documented output shape;
// RECONFIRM against a live sample run before production (README "Phase 0").
const ACTOR_ID = process.env.APIFY_INSTAGRAM_ACTOR_ID || 'apify/instagram-scraper';
const MAX_ITEMS = Number(process.env.APIFY_MAX_ITEMS_PER_QUERY) || 60;
const MAX_QUERIES_PER_RUN = Number(process.env.APIFY_MAX_QUERIES_PER_RUN) || 20;

function contentType(item) {
  const t = (item.type || item.productType || '').toLowerCase();
  if (t.includes('sidecar') || t.includes('carousel')) return 'carousel';
  if (t.includes('video') || t.includes('reel') || item.isReel) return 'reel';
  return 'image';
}

function mapItem(item, query) {
  const nativeId = item.id || item.shortCode || item.url;
  if (!nativeId) return null;
  return {
    nativeId: String(nativeId),
    url: item.url || (item.shortCode ? `https://www.instagram.com/p/${item.shortCode}/` : null),
    contentType: contentType(item),
    caption: item.caption || null,
    transcript: item.transcript || null,
    hashtags: (item.hashtags || []).filter(Boolean),
    mentions: (item.mentions || []).filter(Boolean),
    creator: {
      platformCreatorId: item.ownerId || item.owner?.id || null,
      handle: item.ownerUsername || item.owner?.username || null,
      displayName: item.ownerFullName || item.owner?.fullName || null,
      followerCount: item.owner?.followersCount ?? null,
      verified: item.owner?.verified ?? null
    },
    publishTs: item.timestamp || null,
    thumbnailUrl: item.displayUrl || item.thumbnailUrl || null,
    soundId: item.musicInfo?.audio_id || null,
    soundName: item.musicInfo?.song_name || item.musicInfo?.artist_name || null,
    durationSeconds: item.videoDuration ?? null,
    isSponsored: item.isSponsored ?? null,
    locationCountry: item.locationName || null,
    metrics: {
      playCount: item.videoViewCount ?? item.videoPlayCount ?? null,
      likeCount: item.likesCount ?? null,
      commentCount: item.commentsCount ?? null,
      shareCount: null,   // Instagram does not expose share counts publicly
      saveCount: null
    },
    raw: item,
    query
  };
}

async function collect() {
  if (!process.env.APIFY_TOKEN) {
    console.log('[instagram] skipped: APIFY_TOKEN not set');
    return { platform: 'instagram', skipped: true, fetched: 0, new: 0 };
  }

  const runId = await repo.startSourceRun('instagram');
  const queries = await repo.getActiveQueries('instagram', { maxResults: MAX_QUERIES_PER_RUN });
  const alreadyDoneToday = await repo.countSkippableQueries('instagram');
  runStatus.setStage('instagram', queries.length);
  if (alreadyDoneToday > 0) runStatus.pushLog(`Instagram: skipping ${alreadyDoneToday} quer(ies) collected recently`);
  let fetched = 0;
  let newCount = 0;
  const today = new Date().toISOString().slice(0, 10);

  try {
    for (const q of queries) {
      if (runStatus.isStopRequested()) { runStatus.pushLog('Instagram: stopping.'); break; }
      runStatus.tick(q.query_text);
      let items;
      try {
        // Instagram has no free-text post search -- hashtag search is the
        // closest real capability (matches the pattern already used
        // elsewhere in this account's Apify pipelines).
        items = await runActor(ACTOR_ID, {
          search: q.query_text.replace(/\s+/g, ''),
          searchType: 'hashtag',
          searchLimit: 1,
          resultsLimit: MAX_ITEMS
        });
        await repo.markQuerySuccess(q.id);
      } catch (err) {
        console.error(`[instagram] query "${q.query_text}" failed:`, err.message);
        runStatus.pushLog(`instagram "${q.query_text}" failed: ${err.message}`);
        continue;
      }

      for (const raw of items || []) {
        const mapped = mapItem(raw, q.query_text);
        if (!mapped) continue;
        fetched++;

        if (await repo.isExcludedText(`${mapped.caption} ${mapped.hashtags.join(' ')}`)) continue;

        const rawItemId = await repo.upsertRawItem('instagram', mapped.nativeId, runId, mapped.raw);
        const creatorId = mapped.creator.platformCreatorId
          ? await repo.upsertCreator('instagram', mapped.creator)
          : null;
        const { id: postId, isNew } = await repo.upsertPost({
          platform: 'instagram', nativeId: mapped.nativeId, rawSocialItemId: rawItemId,
          url: mapped.url, contentType: mapped.contentType, caption: mapped.caption,
          transcript: mapped.transcript, hashtags: mapped.hashtags, mentions: mapped.mentions,
          creatorId, publishTs: mapped.publishTs, thumbnailUrl: mapped.thumbnailUrl,
          soundId: mapped.soundId, soundName: mapped.soundName, durationSeconds: mapped.durationSeconds,
          isSponsored: mapped.isSponsored, locationCountry: mapped.locationCountry
        });
        if (isNew) newCount++;
        await repo.recordQueryMatch(postId, q.id);
        await repo.upsertMetricSnapshot(postId, today, mapped.metrics);
      }
    }

    await repo.finishSourceRun(runId, { status: 'success', itemsFetched: fetched, itemsNew: newCount });
    runStatus.pushLog(`Instagram done: ${fetched} fetched, ${newCount} new`);
  } catch (err) {
    await repo.finishSourceRun(runId, { status: 'error', itemsFetched: fetched, itemsNew: newCount, errorMessage: err.message });
    throw err;
  }

  return { platform: 'instagram', skipped: false, fetched, new: newCount };
}

module.exports = { collect };
