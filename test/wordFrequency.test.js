const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { computeWordFrequencies, tokenize } = require('../src/wordFrequency');

describe('tokenize', () => {
  test('lowercases and splits on non-letter characters', () => {
    assert.deepEqual(tokenize("Parking is TOO expensive!!"), ['parking', 'is', 'too', 'expensive']);
  });

  test('collapses contractions instead of splitting them', () => {
    assert.deepEqual(tokenize("Don't do this, it's confusing"), ['dont', 'do', 'this', 'its', 'confusing']);
  });
});

describe('computeWordFrequencies', () => {
  test('excludes generic English stopwords', () => {
    const words = computeWordFrequencies(['The service was not what we expected at all']);
    assert.ok(!words.some((w) => w.word === 'the'));
    assert.ok(!words.some((w) => w.word === 'was'));
    assert.ok(!words.some((w) => w.word === 'what'));
  });

  test('excludes domain nouns already covered by the category breakdown', () => {
    const words = computeWordFrequencies([
      'Melbourne Airport parking was confusing and the train connection was poor',
      'Taxi and rideshare pickup near the terminal was confusing too'
    ]);
    for (const domain of ['melbourne', 'airport', 'parking', 'train', 'taxi', 'rideshare', 'pickup', 'terminal']) {
      assert.ok(!words.some((w) => w.word === domain), `expected "${domain}" to be excluded`);
    }
    assert.ok(words.some((w) => w.word === 'confusing' && w.count === 2));
    assert.ok(words.some((w) => w.word === 'poor'));
  });

  test('excludes short words below the minimum length', () => {
    const words = computeWordFrequencies(['bad bad bad car car car'], { minLength: 4 });
    assert.ok(!words.some((w) => w.word === 'bad'));
  });

  test('counts frequency across multiple texts and sorts descending', () => {
    const words = computeWordFrequencies([
      'staff were rude',
      'staff were rude again',
      'staff were helpful though'
    ]);
    assert.equal(words[0].word, 'staff');
    assert.equal(words[0].count, 3);
    const rude = words.find((w) => w.word === 'rude');
    assert.equal(rude.count, 2);
  });

  test('respects the limit option', () => {
    const texts = ['expensive confusing crowded noisy dirty slow rude unhelpful chaotic disorganized'];
    const words = computeWordFrequencies(texts, { limit: 3 });
    assert.equal(words.length, 3);
  });

  test('returns an empty array for no input', () => {
    assert.deepEqual(computeWordFrequencies([]), []);
    assert.deepEqual(computeWordFrequencies([null, undefined, '']), []);
  });
});
