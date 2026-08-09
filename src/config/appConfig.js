// Default admin-editable configuration -- score weights, lifecycle/durability
// thresholds, evidence minimums, market mode, comment-sample sizes. Seeded
// into app_config on first boot (see seedConfig.js), then editable from
// Admin without a code change (per requirements section 4 + 11).
const DEFAULTS = {
  market_mode: 'global_validated', // global_validated | australia_only

  // A day "counts" toward active_days / consecutive_active_days only if a
  // trend clears this minimum evidence bar that day.
  activity_threshold: {
    min_new_posts: 1,
    min_new_posts_or_comments: 2
  },

  // Minimum evidence before a topic is shown as a validated trend at all
  // (section 14 "minimum evidence threshold before displaying a trend as
  // validated").
  min_evidence_threshold: {
    min_total_posts: 3,
    min_unique_creators: 2
  },

  // Durability label thresholds, in active_days (section 7.4). Configurable;
  // "Validated" does not by itself mean "buy it."
  durability_thresholds: {
    flash: [1, 3],
    early: [4, 6],
    validated: [7, 20],
    sustained: [21, 89],
    established: [90, null]
  },

  // Lifecycle-stage rule thresholds (section 7.4).
  lifecycle_thresholds: {
    new_signal_max_age_days: 3,
    accelerating_growth_pct: 30,   // 7d vs prior 7d growth to call "accelerating"
    peaking_flatten_pct: 10,       // growth within +/-this% counts as "flattening"
    cooling_decline_pct: 35,       // decline from peak 7d window to call "cooling"
    sustained_consecutive_days: 21,
    recurrence_gap_days: 5         // inactive gap before a comeback counts as "recurring"
  },

  // Typical time from trend identification to product on shelf. Materially
  // affects Buying Opportunity scoring (remaining-window calculation).
  // Decision #6 in the requirements doc -- default placeholder pending
  // Sportsgirl buying-team input.
  buying_lead_time_days: 45,

  comment_sampling: {
    shallow_sample_size: 15,
    deep_sample_size: 60,
    deep_sample_post_limit: 10
  },

  score_weights: {
    formula_version: '1.0.0',
    social: {
      momentum_freshness: 25,
      engagement_quality: 20,
      creator_breadth: 15,
      relevance: 15,
      visual_quality: 10,
      product_connection: 10,
      saturation_penalty_max: 15,
      safety_penalty_max: 100
    },
    buying: {
      persistence_duration: 20,
      growth_multi_period: 15,
      australian_confirmation: 15,
      product_specificity: 10,
      purchase_intent: 15,
      creator_breadth: 10,
      google_trends_confirmation: 10,
      range_fit: 5,
      lead_time_penalty_max: 20,
      saturation_penalty_max: 10,
      safety_penalty_max: 100
    },
    confidence: {
      evidence_volume: 25,
      source_coverage: 20,
      data_completeness: 20,
      geographic_confirmation: 15,
      creator_diversity: 10,
      clustering_certainty: 10
    }
  }
};

module.exports = { DEFAULTS };
