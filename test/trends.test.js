const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { extractSignificant, normalizeItem, isBreakoutItem } = require('../src/trends');

// Shapes below match apify/google-trends-scraper's documented dataset output
// (relatedQueries_rising: {query, value, formattedValue, link}) -- see the
// actor's README example fetched directly from Apify's API while building this.

describe('isBreakoutItem', () => {
  test('detects Google\'s literal "Breakout" label', () => {
    assert.equal(isBreakoutItem({ query: 'x', formattedValue: 'Breakout' }), true);
  });

  test('detects a missing numeric value (Trends omits value entirely for breakouts sometimes)', () => {
    assert.equal(isBreakoutItem({ query: 'x', formattedValue: 'Breakout', hasData: true }), true);
  });

  test('is false for an ordinary percentage increase', () => {
    assert.equal(isBreakoutItem({ query: 'x', value: 250, formattedValue: '+250%' }), false);
  });
});

describe('normalizeItem', () => {
  test('carries through the theme, query, numeric change, and an absolute trends.google.com link', () => {
    const r = normalizeItem('Parking', { query: 'long term parking', value: 300, formattedValue: '+300%', link: '/trends/explore?q=long+term+parking' });
    assert.equal(r.theme, 'Parking');
    assert.equal(r.query, 'long term parking');
    assert.equal(r.changePct, 300);
    assert.equal(r.isBreakout, false);
    assert.equal(r.link, 'https://trends.google.com/trends/explore?q=long+term+parking');
  });

  test('changePct is null for a breakout with no numeric value', () => {
    const r = normalizeItem('Parking', { query: 'new terminal parking', formattedValue: 'Breakout', link: '/x' });
    assert.equal(r.changePct, null);
    assert.equal(r.isBreakout, true);
  });
});

describe('extractSignificant', () => {
  const sample = [
    { query: 'brand new spike', formattedValue: 'Breakout', link: '/a' },
    { query: 'doubled search', value: 100, formattedValue: '+100%', link: '/b' },
    { query: 'tripled search', value: 250, formattedValue: '+250%', link: '/c' },
    { query: 'mild uptick', value: 40, formattedValue: '+40%', link: '/d' },
    { query: 'barely rising', value: 5, formattedValue: '+5%', link: '/e' }
  ];

  test('excludes queries below the significance threshold', () => {
    const results = extractSignificant('Parking', sample);
    assert.ok(!results.some((r) => r.query === 'mild uptick'));
    assert.ok(!results.some((r) => r.query === 'barely rising'));
  });

  test('includes breakouts and >=100% increases, breakouts sorted first', () => {
    const results = extractSignificant('Parking', sample);
    assert.equal(results[0].query, 'brand new spike');
    assert.equal(results[0].isBreakout, true);
    assert.ok(results.some((r) => r.query === 'doubled search'));
    assert.ok(results.some((r) => r.query === 'tripled search'));
  });

  test('sorts non-breakout results by change percentage descending', () => {
    const results = extractSignificant('Parking', sample).filter((r) => !r.isBreakout);
    assert.equal(results[0].query, 'tripled search');
    assert.equal(results[1].query, 'doubled search');
  });

  test('caps results per theme', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ query: `spike ${i}`, value: 500, formattedValue: '+500%', link: '/x' }));
    const results = extractSignificant('Parking', many);
    assert.equal(results.length, 5);
  });

  test('returns an empty array when there are no rising queries at all', () => {
    assert.deepEqual(extractSignificant('Parking', []), []);
    assert.deepEqual(extractSignificant('Parking', undefined), []);
  });
});
