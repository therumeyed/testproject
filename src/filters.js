// Shared query-filter parsing/building for /api/mentions and /api/analytics
// so both are guaranteed to apply identical filter logic -- required so
// KPIs, charts and the mention list can never disagree with each other.
// Pure functions, no DB dependency, so this is unit-testable on its own.

function parseFilters(query) {
  const days = Number(query.days) || 14;
  let from;
  let to;
  if (query.from && query.to) {
    from = new Date(query.from);
    to = new Date(query.to);
  } else {
    to = new Date();
    from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
  }
  return {
    from,
    to,
    days,
    source: query.source || null,
    sentiment: query.sentiment || null,
    category: query.category || null,
    q: query.q || null,
    discarded: !!query.discarded
  };
}

// Builds a WHERE clause + params for an explicit [from, to) window, separate
// from the filters' own from/to, so the same filters can be re-applied to a
// "previous equivalent period" window for comparison.
function buildWhere(filters, from, to) {
  const params = [from.toISOString(), to.toISOString()];
  const conditions = [
    filters.discarded ? 'relevant = false' : 'relevant IS DISTINCT FROM false',
    'first_seen_at >= $1',
    'first_seen_at < $2'
  ];
  if (filters.source) {
    params.push(filters.source);
    conditions.push(`source = $${params.length}`);
  }
  if (filters.sentiment) {
    params.push(filters.sentiment);
    conditions.push(`sentiment = $${params.length}`);
  }
  if (filters.category) {
    params.push(filters.category);
    conditions.push(`COALESCE(category, 'unclassified') = $${params.length}`);
  }
  if (filters.q) {
    params.push(`%${filters.q}%`);
    conditions.push(`(title ILIKE $${params.length} OR snippet ILIKE $${params.length})`);
  }
  return { where: conditions.join(' AND '), params };
}

function previousPeriod(from, to) {
  const spanMs = to.getTime() - from.getTime();
  return { from: new Date(from.getTime() - spanMs), to: from };
}

module.exports = { parseFilters, buildWhere, previousPeriod };
