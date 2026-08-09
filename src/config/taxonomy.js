// Seed taxonomy from the product requirements (section 3.2/3.3). This is the
// STARTING point only -- rows land in the taxonomy_terms table on first boot
// (see seedConfig.js) and are editable from Admin from then on. The system
// also discovers new aliases/aesthetics beyond this literal list (see
// cluster.js) rather than matching only what's here.

const PARENT_CATEGORIES = {
  beauty_tools_accessories: 'Beauty Tools and Accessories',
  cosmetics: 'Cosmetics',
  beauty_gift_packs: 'Beauty Gift Packs'
};

// term_type: 'include' seeds discovery queries / relevance matching.
// 'exclude' marks a topic as explicitly out of scope even if it matches an
// include term (e.g. "hair dryer" must never surface even under "tools").
// 'negative_keyword' suppresses noisy false positives at the filtering step.
const SEED_TERMS = [
  // --- A. Beauty Tools and Accessories --------------------------------
  ...[
    'false lashes', 'strip lashes', 'lash clusters', 'individual lashes',
    'lash glue', 'lash adhesive', 'lash applicator', 'lash tweezers', 'lash curler',
    'press-on nails', 'stick-on nails', 'nail stickers', 'nail gems', 'nail decals',
    'nail glue', 'nail art pen', 'nail file', 'nail buffer', 'nail care kit',
    'makeup brush', 'brush set', 'beauty sponge', 'blending sponge', 'powder puff',
    'compact mirror', 'handheld mirror', 'makeup bag', 'beauty case', 'travel beauty organiser',
    'festival beauty accessories'
  ].map((term) => ({ parent_category: 'beauty_tools_accessories', term, term_type: 'include' })),

  // --- B. Cosmetics -----------------------------------------------------
  ...[
    'lip gloss', 'lip oil', 'lip balm', 'butter balm', 'lip tint', 'lip stain',
    'lipstick', 'lip liner', 'lip combo', 'eyeshadow palette', 'eyeshadow single',
    'mascara', 'eyeliner', 'brow product', 'blush', 'bronzer', 'highlighter',
    'shimmer stick', 'setting spray', 'glitter pot', 'glitter gel', 'body glitter',
    'face gems', 'rhinestones', 'adhesive jewels', 'festival makeup', 'party makeup',
    'jelly texture makeup', 'chrome makeup', 'metallic makeup', 'holographic makeup',
    'glossy finish', 'dewy finish', 'frosted finish', 'mini beauty product', 'roller ball',
    'duo product', 'trio product'
  ].map((term) => ({ parent_category: 'cosmetics', term, term_type: 'include' })),

  // --- C. Beauty Gift Packs ----------------------------------------------
  ...[
    'lip duo', 'lip trio', 'eye set', 'mascara set', 'eyeliner set', 'palette set',
    'brush set gift', 'nail art kit', 'nail care kit gift', 'press-on nail kit',
    'glitter pack', 'gem pack', 'festival pack', 'party prep pack', 'mini beauty set',
    'travel beauty set', 'handbag beauty set', 'makeup bag bundle', 'stocking filler beauty',
    'advent beauty calendar', 'birthday beauty gift', 'formal beauty gift', 'travel beauty gift',
    'friendship beauty gift'
  ].map((term) => ({ parent_category: 'beauty_gift_packs', term, term_type: 'include' })),

  // --- Explicit exclusions (section 3.3) ---------------------------------
  ...[
    'hair dryer', 'hair straightener', 'curling iron', 'hot brush', 'electrical hair tool',
    'salon equipment', 'professional salon equipment', 'led mask', 'laser device',
    'clinical beauty device', 'injectable', 'botox', 'filler', 'prescription treatment',
    'skincare routine', 'body lotion', 'fragrance', 'perfume', 'haircare', 'shampoo', 'conditioner'
  ].map((term) => ({ parent_category: 'all', term, term_type: 'exclude' })),

  // --- Negative keywords: unsafe / off-brand content ----------------------
  ...[
    'counterfeit', 'dupe scam', 'dangerous hack', 'harmful challenge', 'unsafe application'
  ].map((term) => ({ parent_category: 'all', term, term_type: 'negative_keyword' }))
];

// Beauty-relevant subreddits monitored directly (section 5.2 "relevant
// subreddit monitoring"), in addition to keyword search across Reddit.
const SEED_SUBREDDITS = [
  'MakeupAddiction', 'RedditLaqueristas', 'Nails', 'beauty', 'AsianBeauty',
  'MakeupAddictionAus', 'AusSkincare', 'femalefashionadvice'
];

const SEED_DISCOVERY_QUERIES = [
  ...SEED_TERMS.filter((t) => t.term_type === 'include').map((t) => ({
    query_type: 'keyword',
    query_text: t.term,
    category_hint: t.parent_category
  }))
];

module.exports = { PARENT_CATEGORIES, SEED_TERMS, SEED_DISCOVERY_QUERIES, SEED_SUBREDDITS };
