const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { CATEGORIES, CATEGORY_VALUES, CATEGORY_CONFIDENCE_THRESHOLD } = require('../src/categories');

describe('categories taxonomy', () => {
  test('exposes exactly the 7 values from the brief', () => {
    assert.deepEqual(CATEGORY_VALUES, [
      'parking',
      'pickup_dropoff',
      'taxi_rideshare',
      'public_transport',
      'terminal_experience',
      'general_airport',
      'unclassified'
    ]);
  });

  test('every category has a non-empty label', () => {
    for (const c of CATEGORIES) {
      assert.equal(typeof c.value, 'string');
      assert.ok(c.label && c.label.length > 0, `category ${c.value} is missing a label`);
    }
  });

  test('confidence threshold is 0.70 as specified in the brief', () => {
    assert.equal(CATEGORY_CONFIDENCE_THRESHOLD, 0.7);
  });
});
