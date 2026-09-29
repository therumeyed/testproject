// Google Alerts publishes a plain public Atom feed per alert -- no login,
// no rendering, so this fetches and parses the XML directly instead of
// going through Apify (unlike every other source here, which needs a
// browser/actor to deal with an authenticated or JS-rendered page).
//
// Two things Google Alerts does that a generic Atom parser wouldn't expect:
// 1. Every link is wrapped in a google.com/url redirect (for click tracking)
//    -- the real target is the `url` query param, which is what we actually
//    want to store/link to.
// 2. Titles/content highlight matched terms with <b> tags and HTML-escape
//    everything (so "<b>Airport</b>" appears literally as
//    "&lt;b&gt;Airport&lt;/b&gt;" in the raw feed) -- both need stripping.

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", nbsp: ' ', middot: '·' };

function decodeEntitiesOnce(str) {
  return String(str)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&(lt|gt|amp|quot|apos|nbsp|middot);/g, (_, name) => ENTITIES[name]);
}

// Google Alerts double-encodes entities: the underlying article HTML's own
// "&amp;"/"&nbsp;" becomes "&amp;amp;"/"&amp;nbsp;" once embedded as XML text
// (observed directly in the feed: "on time &amp;amp; under budget"). One
// decode pass only recovers "&amp;"/"&nbsp;" as literal text, still encoded
// -- decode repeatedly until a pass changes nothing (bounded, since normal
// text is stable after at most two passes).
function decodeEntities(str) {
  let prev = String(str);
  for (let i = 0; i < 4; i++) {
    const next = decodeEntitiesOnce(prev);
    if (next === prev) return next;
    prev = next;
  }
  return prev;
}

function stripTags(str) {
  // Google Alerts double-encodes: the highlight tags are literally escaped
  // in the XML (title type="html" contains "&lt;b&gt;" as text, not a real
  // <b> element), so entities must be decoded BEFORE stripping tags --
  // otherwise the still-escaped "<b>" text never matches as a tag at all.
  return decodeEntities(String(str)).replace(/<[^>]+>/g, '').trim();
}

// Google Alerts wraps every link as
// https://www.google.com/url?rct=j&sa=t&url=<real link>&ct=ga&cd=...&usg=...
function unwrapRedirect(href) {
  try {
    const real = new URL(href).searchParams.get('url');
    return real || href;
  } catch {
    return href;
  }
}

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`));
  return m ? m[1] : null;
}

function parseEntry(block) {
  const id = tag(block, 'id');
  const linkMatch = block.match(/<link\s+href="([^"]*)"/);
  const rawTitle = tag(block, 'title');
  const rawContent = tag(block, 'content');
  const published = tag(block, 'published') || tag(block, 'updated');
  if (!id || !linkMatch) return null;

  return {
    id: decodeEntities(id),
    url: unwrapRedirect(decodeEntities(linkMatch[1])),
    title: rawTitle ? stripTags(rawTitle) : null,
    content: rawContent ? stripTags(rawContent) : null,
    published: published ? decodeEntities(published) : null
  };
}

function parseFeed(xml) {
  const entryBlocks = xml.match(/<entry>[\s\S]*?<\/entry>/g) || [];
  return entryBlocks.map(parseEntry).filter(Boolean);
}

async function fetchMentions(sinceDate) {
  const feedUrl = process.env.GOOGLE_ALERTS_RSS_URL;
  if (!feedUrl) {
    console.log('[google_alerts] skipped: GOOGLE_ALERTS_RSS_URL not set');
    return [];
  }

  const res = await fetch(feedUrl);
  if (!res.ok) throw new Error(`Google Alerts feed fetch failed: ${res.status} ${await res.text()}`);
  const xml = await res.text();
  const entries = parseFeed(xml);

  return entries
    .filter((e) => !e.published || new Date(e.published) >= sinceDate)
    .map((e) => ({
      source: 'google_alerts',
      external_id: e.id,
      url: e.url,
      title: e.title,
      snippet: (e.content || '').slice(0, 500),
      author: null,
      posted_at: e.published,
      raw_data: e
    }));
}

module.exports = { fetchMentions, parseFeed };
