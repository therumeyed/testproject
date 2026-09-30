const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { computeSeriesStats, computeYoY } = require('../src/trendsCalculations');

// Builds a run of daily observations counting back from `latestDate`,
// `values[0]` being the latest day, `values[1]` the day before, etc.
function daily(latestDate, values) {
  const end = new Date(latestDate);
  return values.map((value, i) => {
    const d = new Date(end);
    d.setDate(d.getDate() - i);
    return { observationDate: d.toISOString().slice(0, 10), value };
  });
}

describe('computeSeriesStats', () => {
  test('returns null for no observations', () => {
    assert.equal(computeSeriesStats([]), null);
    assert.equal(computeSeriesStats(null), null);
  });

  test('computes current/previous 7-day averages and WoW change from flat, unchanging data', () => {
    const obs = daily('2026-01-31', Array(35).fill(50));
    const stats = computeSeriesStats(obs);
    assert.equal(stats.current7dAvg, 50);
    assert.equal(stats.previous7dAvg, 50);
    assert.equal(stats.wowChangePct, 0);
    assert.equal(stats.spikeStatus, 'normal');
  });

  test('detects a spike: current week well above the 28-day baseline', () => {
    // last 7 days at 90, the 28 days before that steady at 30
    const recent = Array(7).fill(90);
    const baseline = Array(28).fill(30);
    const obs = daily('2026-01-31', [...recent, ...baseline]);
    const stats = computeSeriesStats(obs);
    assert.equal(stats.current7dAvg, 90);
    assert.equal(stats.previous28dBaseline, 30);
    assert.equal(stats.spikeStatus, 'spike');
    assert.equal(stats.wowChangePct, 200); // vs previous 7 days, also part of the 30-baseline here
  });

  test('detects a decline: current week well below the 28-day baseline', () => {
    const recent = Array(7).fill(10);
    const baseline = Array(28).fill(50);
    const obs = daily('2026-01-31', [...recent, ...baseline]);
    const stats = computeSeriesStats(obs);
    assert.equal(stats.spikeStatus, 'decline');
  });

  test('a mild change stays "normal" (below the 50% spike threshold)', () => {
    const recent = Array(7).fill(55);
    const baseline = Array(28).fill(50);
    const obs = daily('2026-01-31', [...recent, ...baseline]);
    const stats = computeSeriesStats(obs);
    assert.equal(stats.spikeStatus, 'normal');
  });

  test('returns null baseline/WoW fields when there is not enough history yet, without throwing', () => {
    const obs = daily('2026-01-31', [40, 42, 38]); // only 3 days total
    const stats = computeSeriesStats(obs);
    assert.equal(stats.current7dAvg, 40); // avg of the 3 available days
    assert.equal(stats.previous7dAvg, null);
    assert.equal(stats.wowChangePct, null);
    assert.equal(stats.spikeStatus, 'normal');
  });
});

describe('computeYoY', () => {
  test('returns null for no observations', () => {
    assert.equal(computeYoY([]), null);
  });

  test('finds the observation ~364 days earlier and computes YoY change', () => {
    const obs = [
      { observationDate: '2025-02-03', value: 40 },
      { observationDate: '2026-02-02', value: 60 }
    ];
    const yoy = computeYoY(obs);
    assert.equal(yoy.latestValue, 60);
    assert.equal(yoy.yearAgoValue, 40);
    assert.equal(yoy.yoyChangePct, 50);
  });

  test('returns null YoY fields when nothing falls within the tolerance window', () => {
    const obs = [
      { observationDate: '2024-01-01', value: 40 },
      { observationDate: '2026-02-02', value: 60 }
    ];
    const yoy = computeYoY(obs);
    assert.equal(yoy.yearAgoValue, null);
    assert.equal(yoy.yoyChangePct, null);
  });
});
