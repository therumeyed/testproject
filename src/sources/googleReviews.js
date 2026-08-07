const { runActor } = require('../apifyClient');

// Overridable in case this actor gets deprecated/renamed -- see README.
const ACTOR_ID = process.env.APIFY_GOOGLE_REVIEWS_ACTOR_ID || 'compass/google-maps-reviews-scraper';

// Accepts either a standard Place ID (ChIJ...) or a numeric CID -- CIDs are
// what you get from a listing's Business Profile Manager URL
// (business.google.com/n/.../profile?fid=NNNN, the fid *is* the CID), which
// in practice is the easiest source for an account that already manages all
// ~10 listings. Verified live: share.google short links don't resolve for
// this actor, but https://www.google.com/maps?cid={CID} does.
function parseLocationIds() {
  const raw = process.env.APIFY_GOOGLE_PLACE_IDS || '';
  const ids = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const placeIds = ids.filter((id) => id.startsWith('ChIJ'));
  const cidUrls = ids
    .filter((id) => !id.startsWith('ChIJ'))
    .map((cid) => ({ url: `https://www.google.com/maps?cid=${cid}` }));
  return { placeIds, cidUrls };
}

// Actor wants a relative day count ("2 days"), not an absolute cutoff --
// derive it from sinceDate with a 1-day buffer so a slightly-late cron run
// never silently misses reviews (the (source, external_id) unique
// constraint absorbs the resulting overlap same as everywhere else).
function relativeWindow(sinceDate) {
  const days = Math.ceil((Date.now() - sinceDate.getTime()) / (24 * 60 * 60 * 1000));
  return `${Math.max(days, 1) + 1} days`;
}

// Covers MelAir's ~10 Google Business Profile listings (one per car park
// product) via place ID, not the official Business Profile API -- that
// requires a manual Google approval (days to weeks, needs a 60+ day verified
// listing) versus this working immediately off public place IDs. Trade-off:
// no ability to reply to reviews through this path, only read them. Worth
// revisiting the official API later if reply-workflow becomes a requirement.
async function fetchMentions(sinceDate) {
  if (!process.env.APIFY_TOKEN) {
    console.log('[google_reviews] skipped: APIFY_TOKEN not set');
    return [];
  }

  const { placeIds, cidUrls } = parseLocationIds();
  if (placeIds.length === 0 && cidUrls.length === 0) {
    console.log('[google_reviews] skipped: APIFY_GOOGLE_PLACE_IDS not set');
    return [];
  }

  const input = {
    reviewsSort: 'newest',
    reviewsStartDate: relativeWindow(sinceDate),
    maxReviews: 50
  };
  if (placeIds.length) input.placeIds = placeIds;
  if (cidUrls.length) input.startUrls = cidUrls;

  const items = await runActor(ACTOR_ID, input);

  return (items || [])
    .filter((d) => !d.publishedAtDate || new Date(d.publishedAtDate) >= sinceDate)
    .map((d) => ({
      source: 'google_reviews',
      external_id: d.reviewUrl || `${d.placeId}_${d.reviewerId}_${d.publishedAtDate}`,
      url: d.reviewUrl || null,
      title: d.title ? `${d.title} — ${d.stars || '?'}★` : null,
      snippet: (d.text || '').slice(0, 500),
      author: d.name || null,
      posted_at: d.publishedAtDate || null,
      raw_data: d
    }));
}

module.exports = { fetchMentions };
