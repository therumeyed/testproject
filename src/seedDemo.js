require('dotenv').config();
// Populates realistic multi-day, multi-platform demo data so the dashboard
// is reviewable end-to-end without live Apify/Anthropic credentials. Real
// deterministic scoring (scoring.js) runs against this seeded data exactly
// as it would against live collector output -- only the raw evidence itself
// and the Claude-authored conversation/recommendation copy are hand-written
// here, and the recommendation copy is skipped (left to `npm run ingest`)
// when ANTHROPIC_API_KEY is actually set, so a real key produces real copy.
const { pool, initSchemaWithRetry } = require('./db');
const { seedConfig } = require('./config/seedConfig');
const repo = require('./lib/repo');
const { computeAllDailyMetrics, computeAndStoreScores } = require('./scoring');
const { isConfigured } = require('./lib/claude');
const { runRecommendations } = require('./recommend');

const DAY_MS = 24 * 60 * 60 * 1000;
const today = new Date();
today.setUTCHours(0, 0, 0, 0);

function iso(d) { return d.toISOString().slice(0, 10); }
function addDays(base, n) { return new Date(base.getTime() + n * DAY_MS); }
function rand(min, max) { return Math.round(min + Math.random() * (max - min)); }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

const CREATOR_POOL = {
  tiktok: ['glowwithmia', 'beautyhackss', 'nails_by_tay', 'sxo.beauty', 'melbmakeupdiary', 'freya.does.faces', 'lipcombotrials', 'aussiebeautyedit'],
  instagram: ['mia.glowco', 'lashandlacquer', 'sydneybeautyedit', 'thebeautydrop_au', 'tayssnailstudio'],
  reddit: ['u_lippieaddict', 'u_nailsandcoffee', 'u_MelbBeautyMod', 'u_glitterandgrit']
};

async function seedSourceRuns() {
  const runs = {};
  for (const platform of ['tiktok', 'instagram', 'reddit', 'google_trends']) {
    runs[platform] = await repo.startSourceRun(platform, 'manual');
    await repo.finishSourceRun(runs[platform], { status: 'success', itemsFetched: 0, itemsNew: 0 });
  }
  return runs;
}

async function makePost({ platform, runId, dayOffsetFromStart, createdDate, caption, hashtags, peak, contentType }) {
  const handle = pick(CREATOR_POOL[platform]);
  const creatorId = await repo.upsertCreator(platform, {
    platformCreatorId: handle,
    handle,
    displayName: handle,
    followerCount: rand(2000, 250000),
    verified: Math.random() < 0.1
  });

  const nativeId = `${platform}_${handle}_${iso(createdDate)}_${dayOffsetFromStart}_${Math.floor(Math.random() * 1e6)}`;
  const raw = { demo: true, caption, hashtags, createdDate: iso(createdDate) };
  const rawItemId = await repo.upsertRawItem(platform, nativeId, runId, raw);

  const { id: postId } = await repo.upsertPost({
    platform, nativeId, rawSocialItemId: rawItemId,
    url: `https://example.com/${platform}/${nativeId}`,
    contentType: contentType || (platform === 'reddit' ? 'text' : 'video'),
    caption, transcript: platform === 'tiktok' ? caption : null,
    hashtags: hashtags || [], mentions: [], creatorId,
    publishTs: createdDate.toISOString(), thumbnailUrl: null,
    isSlideshow: false, isSponsored: false, isPinned: false,
    locationCountry: Math.random() < 0.35 ? 'AU' : null,
    firstSeenAt: createdDate.toISOString()
  });

  await pool.query(`UPDATE social_posts SET is_relevant = true WHERE id = $1`, [postId]);

  // Logistic-ish growth: fast rise over ~4 days, then plateau, from the
  // post's own creation date through to "today" -- one snapshot per day so
  // deltas/velocity are real, not backfilled totals.
  for (let d = createdDate; d <= today; d = addDays(d, 1)) {
    const t = Math.max(0, (d - createdDate) / DAY_MS);
    const growth = 1 - Math.exp(-t / 2.2);
    if (platform === 'reddit') {
      const score = Math.round(peak * 0.25 * growth) + rand(0, 5);
      const commentCount = Math.round(peak * 0.08 * growth) + rand(0, 3);
      await repo.upsertMetricSnapshot(postId, iso(d), { likeCount: score, commentCount });
    } else {
      const plays = Math.round(peak * growth) + rand(0, Math.max(1, Math.round(peak * 0.01)));
      const likes = Math.round(plays * 0.06);
      const comments = Math.round(plays * 0.012);
      const shares = Math.round(plays * 0.018);
      const saves = Math.round(plays * 0.014);
      await repo.upsertMetricSnapshot(postId, iso(d), { playCount: plays, likeCount: likes, commentCount: comments, shareCount: shares, saveCount: saves });
    }
  }

  return postId;
}

async function addComments(postId, platform, comments) {
  const { containsQuestion, containsPurchaseIntent } = require('./lib/textSignals');
  let i = 0;
  for (const body of comments) {
    i++;
    await repo.upsertComment({
      platform, nativeCommentId: `demo_${postId}_${i}`, postId,
      author: pick(CREATOR_POOL[platform] || ['anon']), body,
      score: rand(1, 400), postedTs: new Date().toISOString(),
      containsQuestion: containsQuestion(body), containsPurchaseIntent: containsPurchaseIntent(body)
    });
  }
}

async function createTrend(cfg) {
  const res = await pool.query(
    `INSERT INTO trend_topics (name, definition, parent_category, subcategory, attributes, brand_fit, social_use, buying_use, status, market_au_state, safety_flag, safety_note, first_detected_date, last_active_date)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13)
     RETURNING id`,
    [
      cfg.name, cfg.definition, cfg.parentCategory, cfg.subcategory, JSON.stringify(cfg.attributes || {}),
      cfg.brandFit, cfg.socialUse !== false, cfg.buyingUse !== false, cfg.status || 'active',
      cfg.auState || 'unavailable', cfg.safetyFlag || false, cfg.safetyNote || null, iso(cfg.firstDetectedDate)
    ]
  );
  const trendId = res.rows[0].id;
  for (const alias of cfg.aliases || []) {
    await pool.query(`INSERT INTO trend_aliases (trend_topic_id, alias_text) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [trendId, alias]);
  }
  return trendId;
}

async function linkPosts(trendId, postIds) {
  for (const postId of postIds) {
    await pool.query(
      `INSERT INTO trend_post_matches (trend_topic_id, post_id, match_confidence) VALUES ($1,$2,0.9)
       ON CONFLICT (trend_topic_id, post_id) WHERE post_id IS NOT NULL DO NOTHING`,
      [trendId, postId]
    );
  }
}

async function addConversationSummary(trendId, summary) {
  await pool.query(
    `INSERT INTO trend_recommendations (trend_topic_id, rec_type, payload) VALUES ($1, 'conversation_summary', $2)`,
    [trendId, JSON.stringify(summary)]
  );
}

async function addHardcodedRecommendations(trendId, socialIdea, buyingOpportunity) {
  if (socialIdea) {
    await pool.query(
      `INSERT INTO trend_recommendations (trend_topic_id, rec_type, payload, status) VALUES ($1, 'social_idea', $2, 'new')`,
      [trendId, JSON.stringify(socialIdea)]
    );
  }
  if (buyingOpportunity) {
    await pool.query(
      `INSERT INTO trend_recommendations (trend_topic_id, rec_type, payload, status) VALUES ($1, 'buying_opportunity', $2, 'watch')`,
      [trendId, JSON.stringify(buyingOpportunity)]
    );
  }
}

// dailyPattern: array of new-post counts (TikTok-weighted; Instagram/Reddit
// scale down from it), oldest day first, ending today.
async function seedEvidence(runs, { platforms, dailyPattern, captionFn, hashtags, peakRange, commentsPool }) {
  const startDate = addDays(today, -(dailyPattern.length - 1));
  const postIds = [];
  for (let i = 0; i < dailyPattern.length; i++) {
    const day = addDays(startDate, i);
    const count = dailyPattern[i];
    for (let n = 0; n < count; n++) {
      for (const platform of platforms) {
        if (platform !== 'tiktok' && Math.random() < 0.45) continue; // fewer posts on secondary platforms
        const peak = rand(peakRange[0], peakRange[1]);
        const postId = await makePost({
          platform, runId: runs[platform], dayOffsetFromStart: i, createdDate: day,
          caption: captionFn(), hashtags, peak
        });
        postIds.push(postId);
        if (commentsPool && commentsPool.length && Math.random() < 0.6) {
          const sample = [...commentsPool].sort(() => Math.random() - 0.5).slice(0, rand(1, 3));
          await addComments(postId, platform, sample);
        }
      }
    }
  }
  return { postIds, startDate };
}

// "Breakout" is a property of Google's rising RELATED queries, not of the
// daily interest-index timeline (see scoring.js getGoogleTrendsSignal) --
// pass breakoutQuery to seed one for trends meant to demo that state.
async function seedGoogleTrends(trendId, name, { au, global, breakoutQuery }) {
  const startDate = addDays(today, -29);
  for (let i = 0; i < 30; i++) {
    const day = addDays(startDate, i);
    const auVal = Math.max(0, Math.round(au[0] + (au[1] - au[0]) * (i / 29) + rand(-5, 5)));
    const globalVal = Math.max(0, Math.round(global[0] + (global[1] - global[0]) * (i / 29) + rand(-5, 5)));
    await pool.query(
      `INSERT INTO google_trends_series (trend_topic_id, country, search_term, series_date, interest_index)
       VALUES ($1,'AU',$2,$3,$4) ON CONFLICT DO NOTHING`,
      [trendId, name, iso(day), auVal]
    );
    await pool.query(
      `INSERT INTO google_trends_series (trend_topic_id, country, search_term, series_date, interest_index)
       VALUES ($1,'GLOBAL',$2,$3,$4) ON CONFLICT DO NOTHING`,
      [trendId, name, iso(day), globalVal]
    );
  }
  if (breakoutQuery) {
    await pool.query(
      `INSERT INTO trend_related_queries (trend_topic_id, country, query_text, rising_value, series_date) VALUES ($1,'AU',$2,'Breakout',$3)`,
      [trendId, breakoutQuery, iso(today)]
    );
  }
}

async function seedProducts() {
  const products = [
    { sku: 'SG-LIP-2201', name: 'Sportsgirl Clear Shine Lip Gloss', category: 'cosmetics', subcategory: 'lip', colour: 'clear', finish: 'high-shine', price: 12.95, stockStatus: 'in_stock', lifecycleState: 'continuity' },
    { sku: 'SG-LIP-2210', name: 'Sportsgirl Brown Lip Liner', category: 'cosmetics', subcategory: 'lip', colour: 'brown', finish: 'matte', price: 8.95, stockStatus: 'in_stock', lifecycleState: 'continuity' },
    { sku: 'SG-NAIL-1187', name: 'Sportsgirl Press-On Nails - Almond', category: 'beauty_tools_accessories', subcategory: 'nails', colour: 'nude', shape: 'almond', price: 14.95, stockStatus: 'in_stock', lifecycleState: 'new' },
    { sku: 'SG-GIFT-3305', name: 'Sportsgirl Mini Beauty Bag Set', category: 'beauty_gift_packs', subcategory: 'travel', packType: 'bundle', price: 24.95, stockStatus: 'in_stock', lifecycleState: 'new' }
  ];
  const ids = {};
  for (const p of products) {
    const res = await pool.query(
      `INSERT INTO sportsgirl_products (sku, name, category, subcategory, colour, finish, shape, pack_type, price, stock_status, lifecycle_state)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (sku) DO UPDATE SET name = $2 RETURNING id`,
      [p.sku, p.name, p.category, p.subcategory, p.colour || null, p.finish || null, p.shape || null, p.packType || null, p.price, p.stockStatus, p.lifecycleState]
    );
    ids[p.sku] = res.rows[0].id;
  }
  return ids;
}

async function run() {
  await initSchemaWithRetry();
  await seedConfig();

  const existing = await pool.query(`SELECT count(*)::int AS n FROM trend_topics`);
  if (existing.rows[0].n > 0) {
    console.log(`[seed-demo] trend_topics already has ${existing.rows[0].n} row(s) -- skipping to avoid duplicating demo data. Truncate tables manually first if you want a clean reseed.`);
    await pool.end();
    return;
  }

  const runs = await seedSourceRuns();
  const productIds = await seedProducts();

  // --- Trend 1: the requirements doc's own worked example ----------------
  const t1 = await createTrend({
    name: 'Brown liner + clear gloss lip combo',
    definition: 'A two-step lip look pairing a brown/espresso liner with a high-shine clear gloss on top.',
    parentCategory: 'cosmetics', subcategory: 'lip',
    attributes: { productType: ['lip liner', 'lip gloss'], colour: ['brown', 'espresso'], finish: ['high-shine', 'clear'], occasion: ['everyday', 'going out'] },
    aliases: ['espresso lips', 'brown liner combo', 'coffee lip combo'],
    brandFit: 'core', auState: 'emerging', socialUse: true, buyingUse: true,
    firstDetectedDate: addDays(today, -12)
  });
  const e1 = await seedEvidence(runs, {
    platforms: ['tiktok', 'instagram', 'reddit'],
    dailyPattern: [1, 2, 2, 3, 2, 3, 4, 3, 5, 4, 6, 5, 4],
    captionFn: () => pick([
      'brown liner + clear gloss combo is EVERYTHING rn 🤎✨', 'affordable lip combo that looks expensive',
      'espresso lips tutorial for beginners', 'this liner+gloss combo is taking over my fyp',
      'trying the brown liner clear gloss trend'
    ]),
    hashtags: ['browlinercombo', 'espressolips', 'liplinercombo', 'beautytiktok'],
    peakRange: [8000, 65000],
    commentsPool: [
      'where can i get an affordable liner like this??', 'need this combo asap', 'does sportsgirl sell a brown liner?',
      'omg taking my money', 'how long does this actually last on the lips?', 'is this dupe for the expensive one?'
    ]
  });
  await linkPosts(t1, e1.postIds);
  await seedGoogleTrends(t1, 'brown lip liner gloss combo', { au: [15, 42], global: [25, 55], breakoutQuery: 'espresso lips near me' });
  await addConversationSummary(t1, {
    conversationThemes: ['Affordable two-step lip look', 'Pairing a brown liner with clear gloss for definition without heaviness'],
    questions: ['Where can I buy an affordable brown liner?', 'How long does the combo last before reapplying?'],
    purchaseSignals: ['need this combo asap', 'does sportsgirl sell a brown liner?', 'taking my money'],
    barriers: ['Some worry gloss alone feels sticky'],
    confidence: 0.78
  });
  await addHardcodedRecommendations(t1,
    { title: 'Three-combo brown liner + gloss try-on', format: 'TikTok/Reel', audienceInsight: 'Our audience wants an expensive-looking lip with an affordable two-step routine.', contentAngle: 'Try three brown-liner-and-gloss pairings in one clip using Sportsgirl liner + gloss.', hook: '"This $20 lip combo is all over TikTok right now"', visualExecution: 'Quick cuts between three combos, close-up swatch shots, natural light.', structureGuidance: '15-30s vertical video, 3 pairings, 5s each + final full-face shot', captionDirection: 'Lead with the trend name, tag the products, ask which combo people liked best.', hashtags: ['browlinercombo', 'espressolips', 'sportsgirlbeauty'], treatmentType: 'staff', productMatch: 'Sportsgirl Brown Lip Liner + Clear Shine Lip Gloss', riskNotes: 'None identified.', whyNow: 'Active for 9+ consecutive days across 3 platforms with rising AU search interest.', effortLevel: 'low', shelfLife: 'this week' },
    { productOpportunity: 'Brown liner + clear gloss lip duo/kit', attributes: 'Colour: brown/espresso liner; clear high-shine gloss; paired duo pack format', evidenceOfPersistence: 'Active 9+ consecutive days across TikTok, Instagram and Reddit.', purchaseIntentEvidence: 'Multiple comments asking where to buy an affordable version of this combo.', opportunityWindow: 'Still rising -- Australian search interest is emerging, not yet peaked.', leadTimeRisk: 'low', suggestedAction: 'brief_supplier', reasoning: 'Sustained multi-platform demand, clear purchase intent, and an existing Sportsgirl liner/gloss range that a paired kit could be built from.' }
  );

  // --- Trend 2: validated nail trend -------------------------------------
  const t2 = await createTrend({
    name: 'Short square chrome press-on nails',
    definition: 'Short, square-shaped press-on nails in a mirror-chrome finish.',
    parentCategory: 'beauty_tools_accessories', subcategory: 'nails',
    attributes: { productType: ['press-on nails'], colour: ['silver', 'chrome'], shape: ['short square'], finish: ['chrome', 'mirror'] },
    aliases: ['chrome press-ons', 'mirror nails'],
    brandFit: 'adjacent', auState: 'confirmed', socialUse: true, buyingUse: true,
    firstDetectedDate: addDays(today, -20)
  });
  const e2 = await seedEvidence(runs, {
    platforms: ['tiktok', 'instagram'],
    dailyPattern: [1, 1, 2, 1, 2, 2, 3, 2, 2, 3, 2, 3, 2, 3, 2, 2, 3, 2, 3, 2, 3],
    captionFn: () => pick(['chrome press-ons application in under 5 min', 'short square chrome nails hit different', 'affordable press on nail set review']),
    hashtags: ['chromenails', 'pressonnails', 'nailtok'],
    peakRange: [5000, 30000],
    commentsPool: ['how long do these last?', 'where do i buy a set like this', 'need this in every colour', 'do these damage your natural nails?']
  });
  await linkPosts(t2, e2.postIds);
  await seedGoogleTrends(t2, 'chrome press on nails', { au: [30, 55], global: [35, 60] });
  await addConversationSummary(t2, {
    conversationThemes: ['Quick at-home application', 'Mirror/chrome finish as a statement look'],
    questions: ['How long do press-ons last?', 'Do they damage natural nails?'],
    purchaseSignals: ['where do i buy a set like this', 'need this in every colour'],
    barriers: ['Concern about nail damage from adhesive'],
    confidence: 0.71
  });
  await addHardcodedRecommendations(t2,
    { title: '60-second chrome press-on application', format: 'tutorial', audienceInsight: 'Customers want salon-look nails without the time or cost.', contentAngle: 'Speed-application demo showing how easy the short-square chrome shape is to apply.', hook: '"Salon nails in 60 seconds for under $15"', visualExecution: 'Overhead hands shot, timer on screen, before/after.', structureGuidance: '30-45s vertical video', captionDirection: 'Emphasise speed and price.', hashtags: ['chromenails', 'pressonnails'], treatmentType: 'UGC-style', productMatch: 'Sportsgirl Press-On Nails - Almond (closest current shape; short square is a range gap)', riskNotes: 'None identified.', whyNow: 'Validated trend, active 7+ of the last 10 days with confirmed AU search interest.', effortLevel: 'low', shelfLife: 'this week' },
    { productOpportunity: 'Short square chrome press-on nail set', attributes: 'Shape: short square (current range gap -- existing SKU is almond); finish: chrome/mirror', evidenceOfPersistence: 'Active most days over a 3-week window.', purchaseIntentEvidence: 'Comments asking where to buy and requesting more colourways.', opportunityWindow: 'Confirmed Australian search interest, steady rather than spiking -- durable near-term opportunity.', leadTimeRisk: 'medium', suggestedAction: 'investigate', reasoning: 'Consistent 3-week demand with confirmed AU interest and a specific shape/finish gap versus the current range.' }
  );

  // --- Trend 3: early / thin evidence (watchlist) -------------------------
  const t3 = await createTrend({
    name: 'Jelly-finish blush tint',
    definition: 'A bouncy, jelly-textured blush tint applied for a dewy flushed look.',
    parentCategory: 'cosmetics', subcategory: 'face',
    attributes: { format: ['jelly'], finish: ['dewy'], colour: ['coral'] },
    aliases: ['jelly blush', 'bouncy blush tint'],
    brandFit: 'adjacent', auState: 'unavailable', socialUse: true, buyingUse: false,
    firstDetectedDate: addDays(today, -3)
  });
  const e3 = await seedEvidence(runs, {
    platforms: ['tiktok'], dailyPattern: [1, 1, 2],
    captionFn: () => pick(['jelly blush is so bouncy omg', 'trying the jelly tint blush trend']),
    hashtags: ['jellyblush', 'dewymakeup'], peakRange: [1500, 6000], commentsPool: ['is this sticky?', 'where is this from']
  });
  await linkPosts(t3, e3.postIds);
  await addConversationSummary(t3, {
    conversationThemes: ['Novel jelly texture for a dewy flush'],
    questions: ['Is the texture sticky?'],
    purchaseSignals: [],
    barriers: ['Texture is unfamiliar to some viewers'],
    confidence: 0.35
  });

  // --- Trend 4: peaking then cooling (festival-tied) ----------------------
  const t4 = await createTrend({
    name: 'Festival glitter gel eyeliner',
    definition: 'Chunky-glitter gel eyeliner used for festival and party eye looks.',
    parentCategory: 'cosmetics', subcategory: 'eye',
    attributes: { format: ['glitter gel'], productType: ['eyeliner'], occasion: ['festival', 'party'] },
    aliases: ['glitter gel liner', 'festival eyeliner'],
    brandFit: 'core', auState: 'emerging', socialUse: true, buyingUse: true,
    firstDetectedDate: addDays(today, -9)
  });
  const e4 = await seedEvidence(runs, {
    platforms: ['tiktok', 'instagram'],
    dailyPattern: [1, 2, 4, 6, 8, 5, 3, 2, 1, 1],
    captionFn: () => pick(['festival glitter liner look', 'glitter gel eyeliner for the weekend', 'party eye look using glitter gel liner']),
    hashtags: ['glitterliner', 'festivalmakeup'], peakRange: [4000, 45000],
    commentsPool: ['does this smudge?', 'need this for the weekend', 'where can i get this shade']
  });
  await linkPosts(t4, e4.postIds);
  await seedGoogleTrends(t4, 'glitter gel eyeliner', { au: [40, 20], global: [50, 25] });
  await addConversationSummary(t4, {
    conversationThemes: ['Statement festival/party eye looks', 'Longevity concerns for glitter formulas'],
    questions: ['Does it smudge or crease?'],
    purchaseSignals: ['need this for the weekend', 'where can i get this shade'],
    barriers: ['Smudging concerns for all-day wear'],
    confidence: 0.66
  });
  await addHardcodedRecommendations(t4,
    { title: 'Festival-ready glitter liner looks', format: 'trend recreation', audienceInsight: 'Shoppers want a bold, easy festival eye look.', contentAngle: 'Three glitter-liner looks for different festival outfits.', hook: '"3 glitter liner looks for your next festival"', visualExecution: 'Quick GRWM style, close-up eye shots.', structureGuidance: '20-30s vertical video', captionDirection: 'Tie to upcoming event/festival season.', hashtags: ['glitterliner', 'festivalmakeup'], treatmentType: 'creator', productMatch: 'No exact Sportsgirl match yet -- range gap.', riskNotes: 'Momentum is already cooling from its peak -- publish quickly if pursued.', whyNow: 'Past its peak; shelf life is short.', effortLevel: 'medium', shelfLife: 'post within 48 hours' },
    null
  );

  // --- Trend 5: sustained gifting trend -----------------------------------
  const t5 = await createTrend({
    name: 'Mini beauty advent-style gift set',
    definition: 'A small, affordable multi-day beauty gift set in an advent-calendar-style format.',
    parentCategory: 'beauty_gift_packs', subcategory: 'seasonal',
    attributes: { format: ['advent calendar', 'mini'], occasion: ['gifting', 'seasonal', 'birthday'] },
    aliases: ['beauty advent set', 'mini gift calendar'],
    brandFit: 'core', auState: 'confirmed', socialUse: true, buyingUse: true,
    firstDetectedDate: addDays(today, -25)
  });
  const e5 = await seedEvidence(runs, {
    platforms: ['tiktok', 'instagram', 'reddit'],
    dailyPattern: [1, 1, 1, 2, 1, 2, 2, 3, 2, 3, 2, 3, 3, 4, 3, 4, 3, 4, 5, 4, 5, 4, 5, 6, 5, 6],
    captionFn: () => pick(['unboxing this mini beauty gift set', 'best affordable beauty gift set for under $30', 'mini beauty set haul']),
    hashtags: ['giftset', 'beautygift', 'unboxing'], peakRange: [3000, 22000],
    commentsPool: ['need this for my sister\'s birthday', 'where can i buy this set', 'is this good value for money', 'perfect gift idea']
  });
  await linkPosts(t5, e5.postIds);
  await seedGoogleTrends(t5, 'mini beauty gift set', { au: [20, 48], global: [22, 40] });
  await addConversationSummary(t5, {
    conversationThemes: ['Affordable gifting for birthdays and occasions', 'Value-for-money framing in unboxings'],
    questions: ['Is it good value for money?'],
    purchaseSignals: ['need this for my sister\'s birthday', 'where can i buy this set', 'perfect gift idea'],
    barriers: [],
    confidence: 0.74
  });
  await addHardcodedRecommendations(t5,
    { title: 'Mini gift set unboxing + gifting guide', format: 'product demo', audienceInsight: 'Shoppers are actively looking for affordable, gift-ready beauty sets.', contentAngle: 'Style the Sportsgirl mini beauty bag set as a birthday/friendship gift.', hook: '"The perfect $25 gift she\'ll actually use"', visualExecution: 'Unboxing shot, styled gift-wrap moment.', structureGuidance: '20-30s vertical video', captionDirection: 'Lead with price and occasion.', hashtags: ['giftset', 'beautygift'], treatmentType: 'product-only', productMatch: 'Sportsgirl Mini Beauty Bag Set', riskNotes: 'None identified.', whyNow: 'Sustained demand across 3+ weeks with confirmed AU search interest.', effortLevel: 'low', shelfLife: 'evergreen' },
    { productOpportunity: 'Expand mini/advent-style beauty gift set range', attributes: 'Pack format: mini/advent-style multi-item set; occasion: birthday, seasonal gifting', evidenceOfPersistence: 'Active most days across a 4-week window, still growing.', purchaseIntentEvidence: 'Repeated "where can I buy" and gifting-occasion comments.', opportunityWindow: 'Confirmed AU interest and steady growth -- good runway ahead of gifting seasons.', leadTimeRisk: 'low', suggestedAction: 'approved_for_range', reasoning: 'Longest-running, most consistently growing trend in this set, with confirmed AU demand and an existing product to build on.' }
  );

  // --- Trend 6: out-of-scope, must be suppressed from the client feed ----
  const t6 = await createTrend({
    name: 'Viral ceramic hair dryer',
    definition: 'A high-powered ceramic hair dryer going viral for fast drying claims.',
    parentCategory: 'beauty_tools_accessories', subcategory: 'hair_tools',
    attributes: { productType: ['hair dryer'] },
    aliases: [],
    brandFit: 'out_of_scope', auState: 'unavailable', socialUse: false, buyingUse: false,
    status: 'suppressed',
    firstDetectedDate: addDays(today, -5)
  });
  const e6 = await seedEvidence(runs, {
    platforms: ['tiktok'], dailyPattern: [3, 5, 8, 10, 6],
    captionFn: () => 'this hair dryer dries my hair in HALF the time',
    hashtags: ['hairdryer', 'hairtok'], peakRange: [50000, 400000], commentsPool: ['need this', 'link please']
  });
  await linkPosts(t6, e6.postIds);
  await addConversationSummary(t6, {
    conversationThemes: ['High view count but explicitly out of Sportsgirl\'s range'],
    questions: [], purchaseSignals: [], barriers: [], confidence: 0.9
  });

  // --- Product matches -----------------------------------------------------
  await pool.query(`INSERT INTO trend_product_matches (trend_topic_id, product_id, match_type, match_reason) VALUES ($1,$2,'similar','Existing Sportsgirl lip liner + gloss range could be paired into a duo.') ON CONFLICT DO NOTHING`, [t1, productIds['SG-LIP-2210']]);
  await pool.query(`INSERT INTO trend_product_matches (trend_topic_id, product_id, match_type, match_reason) VALUES ($1,$2,'similar','Same product family (lip gloss), different colour focus.') ON CONFLICT DO NOTHING`, [t1, productIds['SG-LIP-2201']]);
  await pool.query(`INSERT INTO trend_product_matches (trend_topic_id, product_id, match_type, match_reason) VALUES ($1,$2,'family_only','Existing press-on range is almond-shaped, not the trending short-square chrome.') ON CONFLICT DO NOTHING`, [t2, productIds['SG-NAIL-1187']]);
  await pool.query(`INSERT INTO trend_product_matches (trend_topic_id, product_id, match_type, match_reason) VALUES ($1,$2,'exact','Direct match to current mini gift set SKU.') ON CONFLICT DO NOTHING`, [t5, productIds['SG-GIFT-3305']]);

  // --- Roll up deterministic daily metrics + scores across the full history
  const earliestStart = addDays(today, -25);
  let processed = 0;
  for (let d = earliestStart; d <= today; d = addDays(d, 1)) {
    await computeAllDailyMetrics(iso(d));
    await computeAndStoreScores(iso(d));
    processed++;
  }
  console.log(`[seed-demo] computed daily metrics + scores for ${processed} day(s) across 6 demo trends`);

  // --- A little workflow/audit history for the History view ---------------
  await pool.query(
    `INSERT INTO workflow_actions (entity_type, entity_id, action, from_status, to_status, user_email, note)
     VALUES ('trend', $1, 'status_change', 'watch', 'investigate', $2, 'Buyer shortlisted after 3 weeks of sustained demand.')`,
    [t2, process.env.ADMIN_EMAILS?.split(',')[0] || 'admin@sportsgirl.com.au']
  );
  await pool.query(
    `INSERT INTO audit_logs (user_email, action, entity_type, entity_id, reason)
     VALUES ($1, 'seed_demo_data', 'system', 0, 'Initial demo dataset load for MVP review.')`,
    [process.env.ADMIN_EMAILS?.split(',')[0] || 'admin@sportsgirl.com.au']
  );

  if (isConfigured()) {
    console.log('[seed-demo] ANTHROPIC_API_KEY is set -- also generating any missing live recommendations.');
    await runRecommendations();
  }

  const { rows: summary } = await pool.query(
    `SELECT t.id, t.name, t.status, ts.lifecycle_stage, ts.durability_label, ts.social_score, ts.buying_score, ts.confidence_score
     FROM trend_topics t JOIN LATERAL (SELECT * FROM trend_scores WHERE trend_topic_id = t.id ORDER BY score_date DESC LIMIT 1) ts ON true
     ORDER BY t.id`
  );
  console.log('[seed-demo] final trend states:');
  console.table(summary);

  await pool.end();
}

run().catch((err) => {
  console.error('Fatal seed-demo error:', err);
  process.exit(1);
});
