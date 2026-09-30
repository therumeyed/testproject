// Pure, DB-free calculations over a single keyword's interest-over-time
// series -- deliberately never mixes two series together (the daily-90-day
// and weekly-5-year fetches are each normalised by Google against their own
// request window, so the same keyword+date can carry two different,
// mutually incomparable numbers depending on which request it came from).
// Callers must pass observations from exactly one series.

const DAY_MS = 24 * 60 * 60 * 1000;

function avgInWindow(sorted, windowEnd, days) {
  const windowStart = new Date(windowEnd.getTime() - (days - 1) * DAY_MS);
  const inWindow = sorted.filter((o) => {
    const d = new Date(o.observationDate);
    return d >= windowStart && d <= windowEnd;
  });
  if (inWindow.length === 0) return null;
  return inWindow.reduce((sum, o) => sum + o.value, 0) / inWindow.length;
}

function pctChange(current, previous) {
  if (current === null || !previous) return null;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

// A "spike" is the current week meaningfully above the longer 28-day
// baseline (not just above last week, which could itself have been an
// unusually quiet or busy week) -- 50% either direction is the threshold
// for spike/decline, anything smaller is "normal".
const SPIKE_THRESHOLD_PCT = 50;

function computeSeriesStats(observations) {
  if (!observations || observations.length === 0) return null;
  const sorted = [...observations].sort((a, b) => new Date(a.observationDate) - new Date(b.observationDate));
  const latest = sorted[sorted.length - 1];
  const latestDate = new Date(latest.observationDate);

  const current7dAvg = avgInWindow(sorted, latestDate, 7);
  const previous7dEnd = new Date(latestDate.getTime() - 7 * DAY_MS);
  const previous7dAvg = avgInWindow(sorted, previous7dEnd, 7);
  // The 28 days immediately preceding the current 7-day window (i.e. ending
  // where the previous-7-day window ends) -- a longer, steadier reference
  // point for deciding whether this week is genuinely unusual.
  const previous28dBaseline = avgInWindow(sorted, previous7dEnd, 28);

  const wowChangePct = pctChange(current7dAvg, previous7dAvg);
  const vsBaselinePct = pctChange(current7dAvg, previous28dBaseline);

  let spikeStatus = 'normal';
  if (vsBaselinePct !== null) {
    if (vsBaselinePct >= SPIKE_THRESHOLD_PCT) spikeStatus = 'spike';
    else if (vsBaselinePct <= -SPIKE_THRESHOLD_PCT) spikeStatus = 'decline';
  }

  return {
    latestDate: latest.observationDate,
    latestValue: latest.value,
    current7dAvg,
    previous7dAvg,
    wowChangePct,
    previous28dBaseline,
    spikeStatus
  };
}

// Year-over-year movement -- only meaningful on a long weekly series (the
// 5-year fetch), never the 90-day one. Finds the observation nearest 364
// days before the latest one (Google's weekly buckets don't land on exactly
// the same calendar day each year), within a 2-week tolerance.
const YOY_TOLERANCE_DAYS = 14;

function computeYoY(observations) {
  if (!observations || observations.length === 0) return null;
  const sorted = [...observations].sort((a, b) => new Date(a.observationDate) - new Date(b.observationDate));
  const latest = sorted[sorted.length - 1];
  const targetDate = new Date(new Date(latest.observationDate).getTime() - 364 * DAY_MS);

  let nearest = null;
  let nearestDiffMs = Infinity;
  for (const o of sorted) {
    const diffMs = Math.abs(new Date(o.observationDate) - targetDate);
    if (diffMs < nearestDiffMs) {
      nearestDiffMs = diffMs;
      nearest = o;
    }
  }

  const withinTolerance = nearest && nearestDiffMs <= YOY_TOLERANCE_DAYS * DAY_MS;
  return {
    latestDate: latest.observationDate,
    latestValue: latest.value,
    yearAgoDate: withinTolerance ? nearest.observationDate : null,
    yearAgoValue: withinTolerance ? nearest.value : null,
    yoyChangePct: withinTolerance ? pctChange(latest.value, nearest.value) : null
  };
}

module.exports = { computeSeriesStats, computeYoY, SPIKE_THRESHOLD_PCT, YOY_TOLERANCE_DAYS };
