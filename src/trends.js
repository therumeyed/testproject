// Google Trends has no official API -- the explore/related-queries data
// only exists via Trends' own undocumented internal endpoints. A direct,
// unproxied request to those endpoints was tested live from this project's
// own dev environment and came back HTTP 429 on the very first request:
// Google Trends is well known for aggressively blocking datacenter/cloud IP
// ranges, which is exactly what a server's outbound IP looks like. So this
// goes through Apify (the same infrastructure every other scraped source in
// this project already depends on) instead of calling Trends directly.
//
// Even via Apify this stays best-effort: the actor's own 30-day run stats
// show roughly a quarter of runs end FAILED or TIMED-OUT. Every caller here
// must treat an empty/missing result as normal, not an error worth alerting
// on, and this must never be allowed to affect real mention ingestion.
const { runActor } = require('./apifyClient');

const ACTOR_ID = process.env.APIFY_GOOGLE_TRENDS_ACTOR_ID || 'apify/google-trends-scraper';

const THEMES = [
  { theme: 'Melbourne Airport (general)', term: '/m/01nflw' },
  { theme: 'Parking', term: 'melbourne airport parking' },
  { theme: 'Pickup', term: 'melbourne airport pickup' },
  { theme: 'Drop-off', term: 'melbourne airport drop off' }
];

// Only surface what's actually worth a "quick daily update" -- doubled
// search volume or more, or a literal breakout -- capped per theme so this
// stays a short read rather than a dump of every related query Trends has.
const MIN_CHANGE_PCT = 100;
const MAX_PER_THEME = 5;

// Google's own UI shows the literal label "Breakout" in place of a percent
// once the increase is large enough that a percentage is meaningless (a
// query with ~zero prior baseline) -- treat that as "as high as this signal
// goes", not a number.
function isBreakoutItem(item) {
  if (typeof item.formattedValue === 'string' && /breakout/i.test(item.formattedValue)) return true;
  return typeof item.value !== 'number' && item.hasData !== false;
}

function normalizeItem(theme, item) {
  return {
    theme,
    query: item.query,
    changePct: typeof item.value === 'number' ? item.value : null,
    isBreakout: isBreakoutItem(item),
    link: item.link ? `https://trends.google.com${item.link}` : null
  };
}

function extractSignificant(theme, risingItems) {
  return (risingItems || [])
    .map((item) => normalizeItem(theme, item))
    .filter((r) => r.isBreakout || (r.changePct !== null && r.changePct >= MIN_CHANGE_PCT))
    .sort((a, b) => Number(b.isBreakout) - Number(a.isBreakout) || (b.changePct || 0) - (a.changePct || 0))
    .slice(0, MAX_PER_THEME);
}

async function fetchBreakoutQueries() {
  if (!process.env.APIFY_TOKEN) {
    console.log('[trends] skipped: APIFY_TOKEN not set');
    return [];
  }

  const items = await runActor(ACTOR_ID, {
    searchTerms: THEMES.map((t) => t.term),
    isMultiple: false,
    geo: 'AU',
    timeRange: 'now 7-d'
  });

  const results = [];
  for (const { theme, term } of THEMES) {
    // Match each theme back to its own dataset item by the actor's own
    // echoed search term -- never by array position, since nothing here
    // guarantees the actor's output order matches the input order.
    const datasetItem = (items || []).find((d) => d.searchTerm === term || d.inputUrlOrTerm === term);
    if (!datasetItem) {
      console.error(`[trends] no data returned for theme "${theme}" (term "${term}")`);
      continue;
    }
    results.push(...extractSignificant(theme, datasetItem.relatedQueries_rising));
  }
  return results;
}

module.exports = { fetchBreakoutQueries, extractSignificant, normalizeItem, isBreakoutItem, THEMES };
