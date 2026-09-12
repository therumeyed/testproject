const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { classifyMentions } = require('../src/sentiment');

// classifyBatch() isn't exported directly (it's an internal chunk of
// classifyMentions), so these tests drive it through the public
// classifyMentions() entrypoint with a mocked Anthropic response -- this
// also exercises the real chunking/env-guard code paths, not just the
// parsing logic in isolation.

let originalFetch;
let originalApiKey;

beforeEach(() => {
  originalFetch = global.fetch;
  originalApiKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'test-key';
});

afterEach(() => {
  global.fetch = originalFetch;
  if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = originalApiKey;
});

function mockAnthropicResponse(items) {
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ content: [{ text: JSON.stringify(items) }] })
  });
}

describe('classifyMentions category + confidence handling', () => {
  test('passes through a valid category at/above the confidence threshold', async () => {
    mockAnthropicResponse([
      { index: 0, relevant: true, sentiment: 'negative', severity: 'medium', reason: 'parking cost complaint', category: 'parking', category_confidence: 0.7 }
    ]);
    const [result] = await classifyMentions([{ id: 1, source: 'reddit', title: '', snippet: 'parking is too expensive' }]);
    assert.equal(result.category, 'parking');
    assert.equal(result.category_confidence, 0.7);
  });

  test('downgrades a valid category to unclassified when confidence is below 0.70', async () => {
    mockAnthropicResponse([
      { index: 0, relevant: true, sentiment: 'neutral', severity: null, reason: 'vague', category: 'terminal_experience', category_confidence: 0.5 }
    ]);
    const [result] = await classifyMentions([{ id: 2, source: 'youtube', title: '', snippet: 'not sure what this is about' }]);
    assert.equal(result.category, 'unclassified');
    // raw confidence is still stored so a "confidently unclassified" item can
    // be told apart from one that was guessed and downgraded
    assert.equal(result.category_confidence, 0.5);
  });

  test('keeps the raw category_confidence for an already-unclassified item', async () => {
    mockAnthropicResponse([
      { index: 0, relevant: false, sentiment: 'neutral', severity: null, reason: 'about a different airport', category: 'unclassified', category_confidence: 0.9 }
    ]);
    const [result] = await classifyMentions([{ id: 3, source: 'facebook_direct', title: '', snippet: 'Sydney Airport delays today' }]);
    assert.equal(result.category, 'unclassified');
    assert.equal(result.category_confidence, 0.9);
  });

  test('coerces a category value outside the taxonomy to unclassified', async () => {
    mockAnthropicResponse([
      { index: 0, relevant: true, sentiment: 'positive', severity: null, reason: 'great service', category: 'baggage_claim', category_confidence: 0.95 }
    ]);
    const [result] = await classifyMentions([{ id: 4, source: 'google_reviews', title: '', snippet: 'staff were lovely' }]);
    assert.equal(result.category, 'unclassified');
  });

  test('skips (rather than guesses) a mention whose index is missing from the model response', async () => {
    // Model only returned index 1, dropping item 0 entirely -- a real
    // observed LLM batch failure mode. Must not fall back to positional
    // matching, which previously cross-attributed results between items.
    mockAnthropicResponse([
      { index: 1, relevant: true, sentiment: 'negative', severity: 'low', reason: 'confusing signage', category: 'pickup_dropoff', category_confidence: 0.8 }
    ]);
    const results = await classifyMentions([
      { id: 5, source: 'reddit', title: '', snippet: 'first item' },
      { id: 6, source: 'reddit', title: '', snippet: 'second item' }
    ]);
    assert.equal(results.length, 1);
    assert.equal(results[0].id, 6);
    assert.equal(results[0].category, 'pickup_dropoff');
  });

  test('returns nothing when ANTHROPIC_API_KEY is not set, without calling fetch', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    let called = false;
    global.fetch = async () => { called = true; return { ok: true, json: async () => ({}) }; };
    const results = await classifyMentions([{ id: 7, source: 'reddit', title: '', snippet: 'x' }]);
    assert.deepEqual(results, []);
    assert.equal(called, false);
  });
});
