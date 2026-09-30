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

  // Reproduces exactly what a real production word cloud showed: dominated
  // by generic aviation/travel-news vocabulary from Google News/Alerts/web
  // search coverage rather than sentiment-carrying words, because that kind
  // of press content is much higher-volume than genuine customer reviews.
  test('excludes airline/aviation-industry and press-boilerplate noise', () => {
    const words = computeWordFrequencies([
      'Qantas and Jetstar airlines are checking available flight transfers for passengers this morning, follow for more travel information',
      'Virgin and Emirates aviation news: Boeing aircraft jobs at the runway, book your city transfer today',
      '#MelbourneAirport traveling in October, current photo of the manager, need a free check'
    ]);
    for (const noise of [
      'qantas', 'jetstar', 'airlines', 'available', 'transfers', 'passengers', 'travel', 'follow',
      'information', 'virgin', 'emirates', 'aviation', 'boeing', 'aircraft', 'jobs', 'runway', 'book',
      'city', 'transfer', 'melbourneairport', 'traveling', 'october', 'current', 'photo', 'manager',
      'need', 'free', 'check'
    ]) {
      assert.ok(!words.some((w) => w.word === noise), `expected "${noise}" to be excluded`);
    }
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
