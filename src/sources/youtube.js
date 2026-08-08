const { runActor } = require('../apifyClient');
const { matchesPhrase } = require('../textMatch');

// Overridable in case this actor gets deprecated/renamed -- see README.
const ACTOR_ID = process.env.APIFY_YOUTUBE_ACTOR_ID || 'streamers/youtube-scraper';

async function fetchMentions(sinceDate) {
  if (!process.env.APIFY_TOKEN) {
    console.log('[youtube] skipped: APIFY_TOKEN not set');
    return [];
  }

  const query = process.env.SEARCH_QUERY || 'Melbourne Airport';
  const items = await runActor(ACTOR_ID, {
    searchQueries: [query],
    maxResults: 25,
    maxResultsShorts: 10,
    dateFilter: 'today'
  });

  // `date` is a calendar date with no time component, so compare at day
  // granularity rather than against the exact sinceDate timestamp.
  const sinceDay = new Date(sinceDate.toDateString());

  return (items || [])
    .filter((d) => !d.date || new Date(d.date) >= sinceDay)
    // YouTube's own search doesn't honor an exact-phrase query -- it can match
    // videos containing "Melbourne" and "Airport" separately, so enforce the
    // literal phrase ourselves.
    .filter((d) => matchesPhrase(`${d.title || ''} ${d.text || ''}`, query))
    .map((d) => ({
      source: 'youtube',
      external_id: d.id || d.url,
      url: d.url,
      title: d.title || null,
      snippet: (d.text || '').slice(0, 500),
      author: d.channelName || null,
      posted_at: d.date || null,
      raw_data: d
    }));
}

module.exports = { fetchMentions };
