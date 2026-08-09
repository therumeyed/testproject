const { runActor } = require('../lib/apifyClient');
const repo = require('../lib/repo');
const runStatus = require('../lib/runStatus');

// Overridable if this actor gets renamed/deprecated -- see README "Phase 0".
// Field mapping below follows clockworks/tiktok-scraper's documented output
// shape; RECONFIRM against a live sample run before relying on it in
// production (section 18, Phase 0 calibration).
const ACTOR_ID = process.env.APIFY_TIKTOK_ACTOR_ID || 'clockworks/tiktok-scraper';
const MAX_ITEMS = Number(process.env.APIFY_MAX_ITEMS_PER_QUERY) || 60;
// Bounds spend per run rather than trying to hit every seed keyword every
// time -- prioritises queries that haven't succeeded most recently, so
// repeated runs rotate through the full list instead of always spending on
// the same terms (see repo.getActiveQueries).
const MAX_QUERIES_PER_RUN = Number(process.env.APIFY_MAX_QUERIES_PER_RUN) || 20;

function mapItem(item, query) {
  const nativeId = item.id || item.videoId || item.webVideoUrl;
  if (!nativeId) return null;
  const author = item.authorMeta || item.author || {};
  return {
    nativeId: String(nativeId),
    url: item.webVideoUrl || item.url || null,
    contentType: item.isSlideshow ? 'photo_mode' : 'video',
    caption: item.text || item.desc || null,
    transcript: item.videoMeta?.subtitleLinks ? null : (item.transcript || null),
    hashtags: (item.hashtags || []).map((h) => (typeof h === 'string' ? h : h.name)).filter(Boolean),
    mentions: (item.mentions || []).filter(Boolean),
    creator: {
      platformCreatorId: author.id || author.uid || null,
      handle: author.name || author.uniqueId || null,
      displayName: author.nickName || author.nickname || null,
      followerCount: author.fans ?? author.followerCount ?? null,
      verified: author.verified ?? null
    },
    publishTs: item.createTimeISO || (item.createTime ? new Date(item.createTime * 1000).toISOString() : null),
    thumbnailUrl: item.covers?.default || item.videoMeta?.coverUrl || null,
    soundId: item.musicMeta?.musicId || null,
    soundName: item.musicMeta?.musicName || null,
    effectInfo: item.effectStickers ? JSON.stringify(item.effectStickers) : null,
    durationSeconds: item.videoMeta?.duration ?? item.duration ?? null,
    isSlideshow: item.isSlideshow ?? false,
    isSponsored: item.isAd ?? item.isSponsored ?? null,
    isPinned: item.isPinned ?? false,
    locationCountry: item.locationCreated || item.authorMeta?.region || null,
    metrics: {
      playCount: item.playCount ?? null,
      likeCount: item.diggCount ?? item.likeCount ?? null,
      commentCount: item.commentCount ?? null,
      shareCount: item.shareCount ?? null,
      saveCount: item.collectCount ?? null
    },
    raw: item,
    query
  };
}

async function collect() {
  if (!process.env.APIFY_TOKEN) {
    console.log('[tiktok] skipped: APIFY_TOKEN not set');
    return { platform: 'tiktok', skipped: true, fetched: 0, new: 0 };
  }

  const runId = await repo.startSourceRun('tiktok');
  const queries = await repo.getActiveQueries('tiktok', { maxResults: MAX_QUERIES_PER_RUN });
  const alreadyDoneToday = await repo.countSkippableQueries('tiktok');
  runStatus.setStage('tiktok', queries.length);
  if (alreadyDoneToday > 0) runStatus.pushLog(`TikTok: skipping ${alreadyDoneToday} quer(ies) already collected today`);
  let fetched = 0;
  let newCount = 0;
  const today = new Date().toISOString().slice(0, 10);

  try {
    for (const q of queries) {
      runStatus.tick(q.query_text);
      let items;
      try {
        items = await runActor(ACTOR_ID, {
          searchQueries: [q.query_text],
          resultsPerPage: MAX_ITEMS,
          shouldDownloadCovers: false,
          shouldDownloadVideos: false
        });
        await repo.markQuerySuccess(q.id);
      } catch (err) {
        console.error(`[tiktok] query "${q.query_text}" failed:`, err.message);
        runStatus.pushLog(`tiktok "${q.query_text}" failed: ${err.message}`);
        continue;
      }

      for (const raw of items || []) {
        const mapped = mapItem(raw, q.query_text);
        if (!mapped) continue;
        fetched++;

        if (await repo.isExcludedText(`${mapped.caption} ${mapped.hashtags.join(' ')}`)) continue;

        const rawItemId = await repo.upsertRawItem('tiktok', mapped.nativeId, runId, mapped.raw);
        const creatorId = mapped.creator.platformCreatorId
          ? await repo.upsertCreator('tiktok', mapped.creator)
          : null;
        const { id: postId, isNew } = await repo.upsertPost({
          platform: 'tiktok', nativeId: mapped.nativeId, rawSocialItemId: rawItemId,
          url: mapped.url, contentType: mapped.contentType, caption: mapped.caption,
          transcript: mapped.transcript, hashtags: mapped.hashtags, mentions: mapped.mentions,
          creatorId, publishTs: mapped.publishTs, thumbnailUrl: mapped.thumbnailUrl,
          soundId: mapped.soundId, soundName: mapped.soundName, effectInfo: mapped.effectInfo,
          durationSeconds: mapped.durationSeconds, isSlideshow: mapped.isSlideshow,
          isSponsored: mapped.isSponsored, isPinned: mapped.isPinned, locationCountry: mapped.locationCountry
        });
        if (isNew) newCount++;
        await repo.recordQueryMatch(postId, q.id);
        await repo.upsertMetricSnapshot(postId, today, mapped.metrics);
      }
    }

    await repo.finishSourceRun(runId, { status: 'success', itemsFetched: fetched, itemsNew: newCount });
    runStatus.pushLog(`TikTok done: ${fetched} fetched, ${newCount} new`);
  } catch (err) {
    await repo.finishSourceRun(runId, { status: 'error', itemsFetched: fetched, itemsNew: newCount, errorMessage: err.message });
    throw err;
  }

  return { platform: 'tiktok', skipped: false, fetched, new: newCount };
}

module.exports = { collect };
