const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  KEYWORD_GROUP,
  RELATED_QUERY_SEEDS,
  SERIES,
  buildInterestTask,
  buildRelatedQueryTask,
  parseRelatedQueryValue,
  parseInterestGraph,
  parseRelatedQueries
} = require('../src/trends');

describe('task builders', () => {
  test('interest task carries the full 5-keyword group, Australia/English/web, and only the graph item', () => {
    const task = buildInterestTask('past_90_days');
    assert.deepEqual(task.keywords, KEYWORD_GROUP);
    assert.equal(task.keywords.length, 5);
    assert.equal(task.location_name, 'Australia');
    assert.equal(task.language_name, 'English');
    assert.equal(task.type, 'web');
    assert.equal(task.time_range, 'past_90_days');
    assert.deepEqual(task.item_types, ['google_trends_graph']);
  });

  test('related-query task carries exactly one seed keyword, per DataForSEO\'s one-keyword-per-request rule', () => {
    const task = buildRelatedQueryTask('Melbourne Airport parking', 'past_7_days');
    assert.deepEqual(task.keywords, ['Melbourne Airport parking']);
    assert.deepEqual(task.item_types, ['google_trends_queries_list']);
  });

  test('the related-query seed list excludes the near-duplicate "airport parking Melbourne" keyword', () => {
    assert.equal(RELATED_QUERY_SEEDS.length, 4);
    assert.ok(!RELATED_QUERY_SEEDS.includes('airport parking Melbourne'));
    assert.ok(KEYWORD_GROUP.includes('airport parking Melbourne'));
  });
});

describe('parseRelatedQueryValue', () => {
  test('parses a plain percentage string', () => {
    assert.deepEqual(parseRelatedQueryValue('250'), { value: 250, isBreakout: false });
  });

  test('parses a "+N%" formatted value, stripping the sign/percent/commas', () => {
    assert.deepEqual(parseRelatedQueryValue('+1,250%'), { value: 1250, isBreakout: false });
  });

  test('treats the literal "Breakout" label as a breakout with no numeric value', () => {
    assert.deepEqual(parseRelatedQueryValue('Breakout'), { value: null, isBreakout: true });
  });

  test('handles a raw number (not just a string)', () => {
    assert.deepEqual(parseRelatedQueryValue(80), { value: 80, isBreakout: false });
  });

  test('handles missing/unparseable values without throwing', () => {
    assert.deepEqual(parseRelatedQueryValue(null), { value: null, isBreakout: false });
    assert.deepEqual(parseRelatedQueryValue(undefined), { value: null, isBreakout: false });
    assert.deepEqual(parseRelatedQueryValue('n/a'), { value: null, isBreakout: false });
  });
});

// Shapes below match DataForSEO's documented task_get response exactly (see
// https://docs.dataforseo.com/v3/keywords_data/google_trends/explore/task_get/),
// fetched directly from their docs while building this integration.
describe('parseInterestGraph', () => {
  const sampleTask = {
    result: [{
      keywords: ['a', 'b'],
      items: [{
        type: 'google_trends_graph',
        keywords: ['a', 'b'],
        data: [
          { date_from: '2026-01-01', date_to: '2026-01-01', missing_data: false, values: [40, 10] },
          { date_from: '2026-01-02', date_to: '2026-01-02', missing_data: false, values: [50, 20] },
          { date_from: '2026-01-03', date_to: '2026-01-03', missing_data: true, values: [] }
        ]
      }]
    }]
  };

  test('produces one row per keyword per date, tagged with the given series', () => {
    const rows = parseInterestGraph(sampleTask, SERIES.DAILY_INTEREST);
    assert.equal(rows.length, 4); // 2 dates (missing_data excluded) x 2 keywords
    assert.deepEqual(rows[0], { keyword: 'a', series: 'daily_90d', observationDate: '2026-01-01', value: 40 });
    assert.deepEqual(rows[1], { keyword: 'b', series: 'daily_90d', observationDate: '2026-01-01', value: 10 });
  });

  test('skips missing_data points entirely', () => {
    const rows = parseInterestGraph(sampleTask, SERIES.DAILY_INTEREST);
    assert.ok(!rows.some((r) => r.observationDate === '2026-01-03'));
  });

  test('returns an empty array when the graph item is absent (e.g. task only requested queries_list)', () => {
    assert.deepEqual(parseInterestGraph({ result: [{ items: [] }] }, SERIES.DAILY_INTEREST), []);
    assert.deepEqual(parseInterestGraph({ result: [] }, SERIES.DAILY_INTEREST), []);
  });
});

describe('parseRelatedQueries', () => {
  const sampleTask = {
    result: [{
      keywords: ['melbourne airport parking'],
      items: [{
        type: 'google_trends_queries_list',
        data: {
          top: [{ query: 'long term parking', value: '100' }, { query: 'cheap parking', value: '80' }],
          rising: [{ query: 'new parking rates', value: 'Breakout' }, { query: 'parking discount code', value: '+300%' }]
        }
      }]
    }]
  };

  test('produces tagged rows for both top and rising, parsed via parseRelatedQueryValue', () => {
    const rows = parseRelatedQueries(sampleTask, 'melbourne airport parking', SERIES.DAILY_RELATED);
    assert.equal(rows.length, 4);
    const rising = rows.filter((r) => r.queryType === 'rising');
    assert.equal(rising.length, 2);
    assert.ok(rising.some((r) => r.query === 'new parking rates' && r.isBreakout === true && r.value === null));
    assert.ok(rising.some((r) => r.query === 'parking discount code' && r.value === 300));
    assert.ok(rows.every((r) => r.seedKeyword === 'melbourne airport parking' && r.series === 'daily_7d'));
  });

  test('returns an empty array when the queries_list item is absent (e.g. task only requested the graph)', () => {
    assert.deepEqual(parseRelatedQueries({ result: [{ items: [] }] }, 'x', SERIES.DAILY_RELATED), []);
  });
});
