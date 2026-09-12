require('dotenv').config();
const { pool, initSchemaWithRetry, getMentionsNeedingCategoryBackfill, updateCategory } = require('./db');
const { classifyMentions } = require('./sentiment');

const PAGE_SIZE = 200;

// Resumable, idempotent one-off job: categorizes every existing mention with
// no category yet. Safe to re-run any time (e.g. after a crash) -- it only
// ever touches rows still `category IS NULL`, so it can't reclassify
// already-categorized or manually-overridden rows, and can't create
// duplicates since it never inserts anything.
async function run() {
  await initSchemaWithRetry();

  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('[backfill] ANTHROPIC_API_KEY not set -- nothing to do.');
    await pool.end();
    return;
  }

  let afterId = 0;
  let totalProcessed = 0;
  let totalSkipped = 0;

  for (;;) {
    const page = await getMentionsNeedingCategoryBackfill(PAGE_SIZE, afterId);
    if (page.length === 0) break;
    afterId = page[page.length - 1].id; // advance regardless of per-item outcome -- guarantees forward progress this run

    let classifications;
    try {
      classifications = await classifyMentions(page);
    } catch (err) {
      console.error(`[backfill] batch starting after id=${afterId - page.length} failed entirely:`, err.message);
      continue;
    }

    for (const c of classifications) {
      await updateCategory(c.id, { category: c.category, category_confidence: c.category_confidence });
    }
    totalProcessed += classifications.length;
    totalSkipped += page.length - classifications.length;
    console.log(`[backfill] categorized ${classifications.length}/${page.length} in this page (running total: ${totalProcessed}, up to id=${afterId})`);
  }

  console.log(`[backfill] complete. ${totalProcessed} mentions categorized${totalSkipped ? `, ${totalSkipped} skipped (will retry on next run)` : ''}.`);
  await pool.end();
}

run().catch((err) => {
  console.error('[backfill] fatal error:', err.message);
  process.exit(1);
});
