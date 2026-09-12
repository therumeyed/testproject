const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { parseFilters, buildWhere, previousPeriod } = require('../src/filters');

describe('parseFilters', () => {
  test('defaults to a 14-day window when no range/days given', () => {
    const f = parseFilters({});
    assert.equal(f.days, 14);
    assert.equal(f.source, null);
    assert.equal(f.sentiment, null);
    assert.equal(f.category, null);
    assert.equal(f.q, null);
    const spanDays = (f.to.getTime() - f.from.getTime()) / (24 * 60 * 60 * 1000);
    assert.ok(Math.abs(spanDays - 14) < 0.01);
  });

  test('honors an explicit days preset', () => {
    const f = parseFilters({ days: '30' });
    assert.equal(f.days, 30);
    const spanDays = (f.to.getTime() - f.from.getTime()) / (24 * 60 * 60 * 1000);
    assert.ok(Math.abs(spanDays - 30) < 0.01);
  });

  test('honors an explicit from/to range over the days preset', () => {
    const f = parseFilters({ from: '2026-01-01T00:00:00Z', to: '2026-01-08T00:00:00Z', days: '14' });
    assert.equal(f.from.toISOString(), '2026-01-01T00:00:00.000Z');
    assert.equal(f.to.toISOString(), '2026-01-08T00:00:00.000Z');
  });

  test('carries through all simultaneously-applied filters', () => {
    const f = parseFilters({ category: 'parking', sentiment: 'negative', source: 'reddit', q: 'uber' });
    assert.equal(f.category, 'parking');
    assert.equal(f.sentiment, 'negative');
    assert.equal(f.source, 'reddit');
    assert.equal(f.q, 'uber');
  });
});

describe('buildWhere', () => {
  const from = new Date('2026-01-01T00:00:00Z');
  const to = new Date('2026-01-15T00:00:00Z');

  test('with no extra filters, only applies the relevance + date-range conditions', () => {
    const { where, params } = buildWhere(parseFilters({}), from, to);
    assert.equal(where, "relevant IS DISTINCT FROM false AND first_seen_at >= $1 AND first_seen_at < $2");
    assert.deepEqual(params, [from.toISOString(), to.toISOString()]);
  });

  test('combines category + sentiment + source + search with AND logic', () => {
    const filters = parseFilters({ category: 'parking', sentiment: 'negative', source: 'reddit', q: 'uber' });
    const { where, params } = buildWhere(filters, from, to);
    assert.match(where, /^relevant IS DISTINCT FROM false AND first_seen_at >= \$1 AND first_seen_at < \$2 AND source = \$3 AND sentiment = \$4 AND COALESCE\(category, 'unclassified'\) = \$5 AND \(title ILIKE \$6 OR snippet ILIKE \$6\)$/);
    assert.deepEqual(params, [from.toISOString(), to.toISOString(), 'reddit', 'negative', 'parking', '%uber%']);
    // every condition is joined with AND, never OR, so combined filters narrow rather than widen
    assert.ok(!where.includes(' OR ') || where.includes('title ILIKE'));
  });

  test('the "unclassified" category filter matches rows with a NULL category via COALESCE', () => {
    const filters = parseFilters({ category: 'unclassified' });
    const { where, params } = buildWhere(filters, from, to);
    assert.match(where, /COALESCE\(category, 'unclassified'\) = \$3/);
    assert.equal(params[2], 'unclassified');
  });

  test('discarded=true flips the relevance condition instead of dropping it', () => {
    const { where } = buildWhere(parseFilters({ discarded: '1' }), from, to);
    assert.match(where, /^relevant = false/);
  });
});

describe('previousPeriod', () => {
  test('returns the immediately preceding window of equal length', () => {
    const from = new Date('2026-01-15T00:00:00Z');
    const to = new Date('2026-01-29T00:00:00Z'); // 14-day window
    const prev = previousPeriod(from, to);
    assert.equal(prev.to.toISOString(), from.toISOString());
    assert.equal(prev.from.toISOString(), '2026-01-01T00:00:00.000Z');
    assert.equal(prev.to.getTime() - prev.from.getTime(), to.getTime() - from.getTime());
  });
});
