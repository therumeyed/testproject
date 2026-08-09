const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost')
    ? false
    : { rejectUnauthorized: false }
});

// Schema follows the minimum entity list in the product requirements
// (section 12). Raw payloads are always kept alongside normalised fields
// (raw_social_items.raw_json, social_posts.raw_social_item_id) so field
// mappings can be repaired if an Apify Actor changes its output shape
// without needing to re-scrape.
async function initSchema() {
  await pool.query(`
    -- ---------------------------------------------------------------------
    -- Collection plumbing
    -- ---------------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS source_runs (
      id SERIAL PRIMARY KEY,
      platform TEXT NOT NULL,               -- tiktok | instagram | reddit | google_trends
      run_type TEXT NOT NULL DEFAULT 'scheduled', -- scheduled | manual
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      finished_at TIMESTAMPTZ,
      status TEXT,                          -- success | partial | error | skipped
      items_fetched INTEGER,
      items_new INTEGER,
      error_message TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_source_runs_platform ON source_runs(platform, started_at DESC);

    CREATE TABLE IF NOT EXISTS discovery_queries (
      id SERIAL PRIMARY KEY,
      platform TEXT NOT NULL,
      query_type TEXT NOT NULL,             -- keyword | phrase | hashtag | profile | subreddit
      query_text TEXT NOT NULL,
      category_hint TEXT,
      status TEXT NOT NULL DEFAULT 'approved', -- pending_review | approved | rejected
      source TEXT NOT NULL DEFAULT 'seed',  -- seed | discovered
      active BOOLEAN NOT NULL DEFAULT true,
      discovered_from_trend_id INTEGER,
      approved_by TEXT,
      last_success_at TIMESTAMPTZ,          -- last time this query returned results without error
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(platform, query_type, query_text)
    );
    -- Already-deployed databases won't have this column from the CREATE
    -- TABLE above (which only applies on first create) -- add it directly.
    ALTER TABLE discovery_queries ADD COLUMN IF NOT EXISTS last_success_at TIMESTAMPTZ;
    CREATE INDEX IF NOT EXISTS idx_discovery_queries_active ON discovery_queries(platform, active);

    CREATE TABLE IF NOT EXISTS creators (
      id SERIAL PRIMARY KEY,
      platform TEXT NOT NULL,
      platform_creator_id TEXT NOT NULL,
      handle TEXT,
      display_name TEXT,
      follower_count INTEGER,
      verified BOOLEAN,
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(platform, platform_creator_id)
    );

    -- ---------------------------------------------------------------------
    -- Raw + normalised content
    -- ---------------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS raw_social_items (
      id SERIAL PRIMARY KEY,
      platform TEXT NOT NULL,
      native_id TEXT NOT NULL,
      source_run_id INTEGER REFERENCES source_runs(id),
      raw_json JSONB NOT NULL,
      scraped_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(platform, native_id)
    );

    CREATE TABLE IF NOT EXISTS social_posts (
      id SERIAL PRIMARY KEY,
      platform TEXT NOT NULL,
      native_id TEXT NOT NULL,
      raw_social_item_id INTEGER REFERENCES raw_social_items(id),
      url TEXT,
      content_type TEXT,                    -- video | reel | image | carousel | photo_mode | text | other
      caption TEXT,
      transcript TEXT,
      hashtags TEXT[] DEFAULT '{}',
      mentions TEXT[] DEFAULT '{}',
      creator_id INTEGER REFERENCES creators(id),
      publish_ts TIMESTAMPTZ,
      thumbnail_url TEXT,
      sound_id TEXT,
      sound_name TEXT,
      effect_info TEXT,
      duration_seconds NUMERIC,
      is_slideshow BOOLEAN,
      is_sponsored BOOLEAN,
      is_pinned BOOLEAN,
      location_country TEXT,
      is_relevant BOOLEAN,                  -- Claude relevance classification
      relevance_reason TEXT,
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(platform, native_id)
    );
    CREATE INDEX IF NOT EXISTS idx_social_posts_publish ON social_posts(publish_ts);
    CREATE INDEX IF NOT EXISTS idx_social_posts_creator ON social_posts(creator_id);

    -- Daily snapshot of a post's metrics -- never overwritten, so deltas
    -- (new plays in 24h/7d, velocity) can be derived instead of only ever
    -- showing a current total.
    CREATE TABLE IF NOT EXISTS post_metric_snapshots (
      id SERIAL PRIMARY KEY,
      post_id INTEGER NOT NULL REFERENCES social_posts(id) ON DELETE CASCADE,
      snapshot_date DATE NOT NULL,
      play_count BIGINT,
      like_count BIGINT,
      comment_count BIGINT,
      share_count BIGINT,
      save_count BIGINT,
      captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(post_id, snapshot_date)
    );
    CREATE INDEX IF NOT EXISTS idx_pms_date ON post_metric_snapshots(snapshot_date);

    CREATE TABLE IF NOT EXISTS comments (
      id SERIAL PRIMARY KEY,
      platform TEXT NOT NULL,
      native_comment_id TEXT NOT NULL,
      post_id INTEGER REFERENCES social_posts(id) ON DELETE CASCADE,
      subreddit TEXT,
      author TEXT,
      body TEXT,
      score INTEGER,
      posted_ts TIMESTAMPTZ,
      scraped_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      contains_question BOOLEAN DEFAULT false,
      contains_purchase_intent BOOLEAN DEFAULT false,
      UNIQUE(platform, native_comment_id)
    );
    CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id);

    -- Every query that discovered a post -- preserved for auditability even
    -- though a post is only ever stored once.
    CREATE TABLE IF NOT EXISTS post_query_matches (
      id SERIAL PRIMARY KEY,
      post_id INTEGER NOT NULL REFERENCES social_posts(id) ON DELETE CASCADE,
      discovery_query_id INTEGER NOT NULL REFERENCES discovery_queries(id),
      discovered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(post_id, discovery_query_id)
    );

    -- ---------------------------------------------------------------------
    -- Canonical trends
    -- ---------------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS trend_topics (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      definition TEXT,
      parent_category TEXT NOT NULL,        -- beauty_tools_accessories | cosmetics | beauty_gift_packs
      subcategory TEXT,
      attributes JSONB DEFAULT '{}',        -- productType/colour/finish/shape/design/format/occasion/aesthetic
      brand_fit TEXT NOT NULL DEFAULT 'content_only', -- core | adjacent | content_only | out_of_scope
      social_use BOOLEAN DEFAULT true,
      buying_use BOOLEAN DEFAULT true,
      status TEXT NOT NULL DEFAULT 'active', -- active | suppressed | merged
      merged_into_id INTEGER REFERENCES trend_topics(id),
      market_au_state TEXT DEFAULT 'unavailable', -- confirmed | emerging | absent | unavailable
      safety_flag BOOLEAN DEFAULT false,
      safety_note TEXT,
      first_detected_date DATE,
      last_active_date DATE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_trend_topics_status ON trend_topics(status, parent_category);

    CREATE TABLE IF NOT EXISTS trend_aliases (
      id SERIAL PRIMARY KEY,
      trend_topic_id INTEGER NOT NULL REFERENCES trend_topics(id) ON DELETE CASCADE,
      alias_text TEXT NOT NULL,
      alias_type TEXT DEFAULT 'phrase',      -- phrase | hashtag
      approved BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(trend_topic_id, alias_text)
    );

    CREATE TABLE IF NOT EXISTS trend_post_matches (
      id SERIAL PRIMARY KEY,
      trend_topic_id INTEGER NOT NULL REFERENCES trend_topics(id) ON DELETE CASCADE,
      post_id INTEGER REFERENCES social_posts(id) ON DELETE CASCADE,
      comment_id INTEGER REFERENCES comments(id) ON DELETE CASCADE,
      match_confidence NUMERIC,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK (post_id IS NOT NULL OR comment_id IS NOT NULL)
    );
    CREATE INDEX IF NOT EXISTS idx_tpm_trend ON trend_post_matches(trend_topic_id);
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_tpm_post ON trend_post_matches(trend_topic_id, post_id) WHERE post_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_tpm_comment ON trend_post_matches(trend_topic_id, comment_id) WHERE comment_id IS NOT NULL;

    -- Code-calculated daily rollups per trend per platform (never touched by
    -- the LLM -- counts/sums/medians only).
    CREATE TABLE IF NOT EXISTS trend_daily_metrics (
      id SERIAL PRIMARY KEY,
      trend_topic_id INTEGER NOT NULL REFERENCES trend_topics(id) ON DELETE CASCADE,
      metric_date DATE NOT NULL,
      platform TEXT NOT NULL,               -- tiktok | instagram | reddit
      new_posts INTEGER DEFAULT 0,
      cumulative_posts INTEGER DEFAULT 0,
      plays_sum BIGINT,
      plays_new BIGINT,
      likes_sum BIGINT,
      comments_sum BIGINT,
      shares_sum BIGINT,
      saves_sum BIGINT,
      median_plays NUMERIC,
      unique_creators INTEGER DEFAULT 0,
      top_creator_share NUMERIC,             -- 0-1, creator concentration
      purchase_intent_mentions INTEGER DEFAULT 0,
      question_mentions INTEGER DEFAULT 0,
      meets_activity_threshold BOOLEAN DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(trend_topic_id, metric_date, platform)
    );
    CREATE INDEX IF NOT EXISTS idx_tdm_trend_date ON trend_daily_metrics(trend_topic_id, metric_date);

    CREATE TABLE IF NOT EXISTS google_trends_series (
      id SERIAL PRIMARY KEY,
      trend_topic_id INTEGER NOT NULL REFERENCES trend_topics(id) ON DELETE CASCADE,
      country TEXT NOT NULL,
      search_term TEXT NOT NULL,
      series_date DATE NOT NULL,
      interest_index NUMERIC,                -- 0-100 indexed, never absolute volume
      is_breakout BOOLEAN DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(trend_topic_id, country, search_term, series_date)
    );
    CREATE INDEX IF NOT EXISTS idx_gts_trend ON google_trends_series(trend_topic_id, series_date);

    CREATE TABLE IF NOT EXISTS trend_related_queries (
      id SERIAL PRIMARY KEY,
      trend_topic_id INTEGER NOT NULL REFERENCES trend_topics(id) ON DELETE CASCADE,
      country TEXT NOT NULL,
      query_text TEXT NOT NULL,
      rising_value TEXT,                     -- e.g. "+250%" or "Breakout"
      series_date DATE NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- Versioned, code-calculated scores. One row per trend per day so score
    -- history/explainability survives even as the trend keeps moving.
    CREATE TABLE IF NOT EXISTS trend_scores (
      id SERIAL PRIMARY KEY,
      trend_topic_id INTEGER NOT NULL REFERENCES trend_topics(id) ON DELETE CASCADE,
      score_date DATE NOT NULL,
      formula_version TEXT NOT NULL,
      social_score NUMERIC,
      buying_score NUMERIC,
      confidence_score NUMERIC,
      lifecycle_stage TEXT,
      durability_label TEXT,
      trend_age_days INTEGER,
      active_days INTEGER,
      consecutive_active_days INTEGER,
      days_since_peak INTEGER,
      source_agreement_count INTEGER,
      is_provisional BOOLEAN DEFAULT false,  -- true when required source data is missing
      components JSONB DEFAULT '{}',         -- explainability: driver list per score
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(trend_topic_id, score_date)
    );
    CREATE INDEX IF NOT EXISTS idx_trend_scores_date ON trend_scores(score_date);

    -- Claude-generated, evidence-grounded conversation intelligence + ideas.
    CREATE TABLE IF NOT EXISTS trend_recommendations (
      id SERIAL PRIMARY KEY,
      trend_topic_id INTEGER NOT NULL REFERENCES trend_topics(id) ON DELETE CASCADE,
      rec_type TEXT NOT NULL,                -- social_idea | buying_opportunity | conversation_summary
      payload JSONB NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'new',
      owner TEXT,
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_trend_recs_trend ON trend_recommendations(trend_topic_id, rec_type);

    CREATE TABLE IF NOT EXISTS workflow_actions (
      id SERIAL PRIMARY KEY,
      entity_type TEXT NOT NULL,             -- trend | recommendation
      entity_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      from_status TEXT,
      to_status TEXT,
      user_email TEXT,
      note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_entity ON workflow_actions(entity_type, entity_id);

    CREATE TABLE IF NOT EXISTS user_feedback (
      id SERIAL PRIMARY KEY,
      trend_topic_id INTEGER REFERENCES trend_topics(id) ON DELETE CASCADE,
      user_email TEXT,
      is_relevant BOOLEAN,
      comment TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id SERIAL PRIMARY KEY,
      user_email TEXT,
      action TEXT NOT NULL,
      entity_type TEXT,
      entity_id INTEGER,
      before JSONB,
      after JSONB,
      reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- ---------------------------------------------------------------------
    -- Taxonomy, config, product catalogue
    -- ---------------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS taxonomy_terms (
      id SERIAL PRIMARY KEY,
      parent_category TEXT NOT NULL,
      subcategory TEXT,
      term TEXT NOT NULL,
      term_type TEXT NOT NULL DEFAULT 'include', -- include | exclude | negative_keyword
      active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(parent_category, term, term_type)
    );

    CREATE TABLE IF NOT EXISTS app_config (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      updated_by TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS sportsgirl_products (
      id SERIAL PRIMARY KEY,
      sku TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      category TEXT,
      subcategory TEXT,
      description TEXT,
      colour TEXT,
      finish TEXT,
      shape TEXT,
      pack_type TEXT,
      price NUMERIC,
      product_url TEXT,
      image_url TEXT,
      stock_status TEXT,
      lifecycle_state TEXT,                  -- new | continuity | clearance
      imported_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS trend_product_matches (
      id SERIAL PRIMARY KEY,
      trend_topic_id INTEGER NOT NULL REFERENCES trend_topics(id) ON DELETE CASCADE,
      product_id INTEGER REFERENCES sportsgirl_products(id) ON DELETE CASCADE,
      match_type TEXT NOT NULL,              -- exact | similar | family_only | range_gap | not_relevant
      match_reason TEXT,
      corrected_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(trend_topic_id, product_id)
    );
  `);
}

async function initSchemaWithRetry(maxAttempts = 20, delayMs = 5000) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await initSchema();
      return;
    } catch (err) {
      if (attempt === maxAttempts) throw err;
      console.warn(`[db] schema init attempt ${attempt}/${maxAttempts} failed (${err.message}), retrying in ${delayMs}ms...`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

// For long-running processes (the web server) rather than one-shot scripts
// (ingest/seed): a fresh Render Blueprint deploy creates the web service and
// a brand-new Postgres instance at the same time, and first-time database
// provisioning can take well over a minute -- longer than any bounded retry
// budget should reasonably block startup for. This never gives up and never
// throws; it retries with capped exponential backoff until it succeeds, so
// callers should start serving traffic (and answering /api/health) before
// awaiting this, not after.
async function initSchemaForever({ startDelayMs = 3000, maxDelayMs = 20000 } = {}) {
  let delay = startDelayMs;
  let attempt = 0;
  for (;;) {
    attempt++;
    try {
      await initSchema();
      if (attempt > 1) console.log(`[db] schema init succeeded on attempt ${attempt}`);
      return;
    } catch (err) {
      console.warn(`[db] schema init attempt ${attempt} failed (${err.message}), retrying in ${delay}ms...`);
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 1.5, maxDelayMs);
    }
  }
}

module.exports = { pool, initSchema, initSchemaWithRetry, initSchemaForever };
