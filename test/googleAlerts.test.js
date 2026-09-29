const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseFeed } = require('../src/sources/googleAlerts');

// Captured from the real feed URL the user provided, so this parses actual
// Google Alerts output (redirect-wrapped links, <b> highlight tags, HTML
// entities) rather than a hand-written approximation of the format.
const SAMPLE_FEED = fs.readFileSync(path.join(__dirname, 'fixtures', 'google-alerts-sample.xml'), 'utf8');

describe('googleAlerts.parseFeed', () => {
  test('parses every entry in a real feed sample', () => {
    const entries = parseFeed(SAMPLE_FEED);
    assert.ok(entries.length > 0);
    for (const e of entries) {
      assert.equal(typeof e.id, 'string');
      assert.equal(typeof e.url, 'string');
    }
  });

  test('unwraps the google.com/url redirect to the real article link', () => {
    const entries = parseFeed(SAMPLE_FEED);
    const sydneyGuide = entries.find((e) => e.title && e.title.includes('Western Sydney'));
    assert.ok(sydneyGuide, 'expected the Western Sydney Airport entry to be present in the fixture');
    assert.equal(sydneyGuide.url, 'https://www.sydneytravelguide.com.au/news/guide-to-western-sydney-airport/');
    assert.ok(!sydneyGuide.url.includes('google.com/url'));
  });

  test('strips highlight tags and decodes HTML entities from title and content', () => {
    const entries = parseFeed(SAMPLE_FEED);
    for (const e of entries) {
      assert.ok(!e.title || !e.title.includes('<b>'), `title should have <b> tags stripped: ${e.title}`);
      assert.ok(!e.title || !/&\w+;/.test(e.title), `title should have entities fully decoded: ${e.title}`);
      assert.ok(!e.content || !/&\w+;/.test(e.content), `content should have entities fully decoded: ${e.content}`);
    }
    const virgin = entries.find((e) => e.title && e.title.includes('Virgin'));
    assert.ok(virgin);
    assert.match(virgin.title, /Melbourne grand final weekend weather/);
  });

  // Google Alerts double-encodes: the article's own "&" (as "&amp;") becomes
  // "&amp;amp;" once embedded in the feed's XML -- a single decode pass
  // leaves it as the still-escaped "&amp;" rather than a literal "&".
  test('resolves double-encoded entities like "&amp;amp;" down to a literal "&"', () => {
    const entries = parseFeed(SAMPLE_FEED);
    const frequentMiler = entries.find((e) => e.title && e.title.includes('Frequent Miler'));
    assert.ok(frequentMiler, 'expected the Frequent Miler entry to be present in the fixture');
    assert.equal(frequentMiler.title, 'Getting to Melbourne on time & under budget - Frequent Miler');
  });

  test('gives each entry a stable id suitable for (source, external_id) dedupe', () => {
    const entries = parseFeed(SAMPLE_FEED);
    const ids = entries.map((e) => e.id);
    assert.equal(new Set(ids).size, ids.length, 'entry ids must be unique within the feed');
    assert.ok(ids.every((id) => id.startsWith('tag:google.com')));
  });

  test('returns an empty array for a feed with no entries', () => {
    assert.deepEqual(parseFeed('<feed xmlns="http://www.w3.org/2005/Atom"></feed>'), []);
  });
});
