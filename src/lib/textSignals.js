// Cheap deterministic heuristics used to flag comments worth prioritising in
// the (capped) sample sent to Claude later -- section 5.6: "Prioritise
// comments containing questions, product requests, comparisons, purchase
// language, complaints and recreation attempts." Claude does the actual
// interpretation later; this is just a code-level triage filter.

const QUESTION_RE = /\?|^(what|where|how|does|is there|can (i|you)|any(one)?)\b/i;
const PURCHASE_INTENT_RE = /\b(where (can|do) i (buy|get)|link please|need this|want this|must have|adding to cart|taking my money|shut up and take my money|is this available|dupe for|where to buy|price\??$|how much)\b/i;

function containsQuestion(text) {
  return Boolean(text && QUESTION_RE.test(text));
}

function containsPurchaseIntent(text) {
  return Boolean(text && PURCHASE_INTENT_RE.test(text));
}

module.exports = { containsQuestion, containsPurchaseIntent };
