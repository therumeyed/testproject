# Sportsgirl Beauty Radar

A beauty trend intelligence tool for Sportsgirl: it turns TikTok, Instagram, Reddit and Google Trends activity into two separate, evidence-backed outputs -- **what to post this week** (Social Content Desk) and **what to investigate for buying** (Buying Desk) -- rather than a generic "here's what's trending" feed.

This build implements the **Phase 1 intelligence MVP** from the product requirements doc: daily ingestion, deduplication, daily metric snapshots, Claude-based topic clustering, code-only scoring (lifecycle stage, durability, Social/Buying/Confidence scores), evidence-grounded social + buying recommendations, and the full client-facing view set (Overview, Social Content Desk, Buying Desk, Trend Explorer, Trend Detail, Trend History, Compare, Admin).

## 1. What's real vs. simplified in this pass

**Fully implemented, running against live data model + code (not mocked):**
- Full data model (`src/db.js`) covering every entity in the requirements doc's minimum list (raw + normalised posts, daily metric snapshots, comments, canonical trends, aliases, daily rollups, Google Trends series, versioned scores, recommendations, workflow actions, audit log, taxonomy, product catalogue).
- Deterministic scoring engine (`src/scoring.js`): trend age, active days, consecutive active days, days since peak, lifecycle stage, durability label, and separate Social/Buying/Confidence scores -- all code-calculated with a documented, versioned formula (`FORMULA_VERSION` in `scoring.js`) and a full "why this score" component breakdown. No LLM ever touches a number.
- Claude-based topic clustering (`src/cluster.js`) and recommendation generation (`src/recommend.js`), both using validated structured JSON output with retry-on-invalid-JSON, evidence-only grounding, and an explicit path to say "insufficient evidence."
- The full client experience: Overview, Social Content Desk, Buying Desk, Trend Explorer, Trend Detail (evidence page with chart, platform breakdown, conversation intelligence, top evidence, "why this score", product matches), Trend History (dated rankings + movement), Compare (2-5 trends side by side, platform metrics kept separate), Admin (taxonomy, discovery queries, score weights/thresholds, product catalogue, audit log, manual rerun).
- Brand-fit / exclusion filtering: an explicit out-of-scope topic (a viral hair dryer) is seeded in the demo data specifically to prove it gets suppressed from the client feed despite huge view counts.

**Deliberately deferred (Phase 2/3 per the doc's own build phases), not built here:**
- Alerts/weekly digest, feedback-loop-driven re-ranking, seasonal baselines, and the "new alias promoted to monitored query" approval flow beyond the basic pending-review status field.
- Full CSV bulk-import UI for the product catalogue (the API and data model support it; only single-row add is wired into Admin).

**Needs Phase 0 calibration before going live (per the doc's own Phase 0 requirement):**
- Exact Apify Actor IDs and their input/output field names. `src/collectors/*.js` use documented, best-guess field mappings for `clockworks/tiktok-scraper`, `apify/instagram-scraper` and `trudax/reddit-scraper-lite`, and a placeholder Google Trends actor -- all overridable via env vars (see `.env.example`). Run a real sample collection against each before trusting the data.
- Score weights and lifecycle/durability thresholds are seeded with reasonable, documented defaults (`src/config/appConfig.js`) and are fully admin-editable -- calibrate against real volumes once live data is flowing (Phase 0 says exactly this).

## 2. Demoing without live API keys

This repo ships with **no live Apify/Anthropic credentials configured**. So the app is fully reviewable without them:

```bash
npm install
cp .env.example .env          # fill in DATABASE_URL at minimum
npm start                      # dashboard at http://localhost:3000
npm run seed-demo              # populates ~30 days of realistic multi-platform demo data
```

`seed-demo` inserts six canonical demo trends spanning every lifecycle stage (new signal, accelerating, sustained, cooling, an out-of-scope example) with real creators, posts, daily metric snapshots, comments, Google Trends series and product matches -- then runs the **actual** `scoring.js` engine across the full date range so every score/lifecycle/durability label on screen is genuinely code-calculated from the seeded evidence, not hand-written. If `ANTHROPIC_API_KEY` is set, it also generates the real social/buying recommendation copy via Claude; otherwise it falls back to hand-written (but evidence-consistent) example copy so the Social/Buying desks aren't empty. Running `seed-demo` again is a no-op if `trend_topics` already has rows -- truncate the relevant tables first for a clean reseed.

Log in with any email + the `APP_ACCESS_PASSWORD` from your `.env`. An email listed in `ADMIN_EMAILS` gets the Admin tab; anyone else gets standard (read + workflow-status) access.

## 3. Running the real pipeline

```bash
npm run ingest
```

This runs the full daily pipeline: collect (TikTok/Instagram/Reddit via Apify) → cluster into canonical trends (Claude) → validate against Google Trends → roll up deterministic daily metrics and scores → generate social/buying recommendations (Claude). Every collector and the clustering/recommendation steps skip gracefully (and log why) if their API key isn't set, matching the pattern used elsewhere in this account's Apify pipelines -- the rest of the pipeline still runs.

Admin users can also trigger this from the dashboard (Admin → "Run collection now").

## 4. Data sources

| Source | What it collects | Notes |
|---|---|---|
| TikTok | Posts matching seed keywords, via Apify | `APIFY_TIKTOK_ACTOR_ID`, defaults to `clockworks/tiktok-scraper` |
| Instagram | Hashtag search (Instagram has no free-text post search) | `APIFY_INSTAGRAM_ACTOR_ID`, defaults to `apify/instagram-scraper` |
| Reddit | Keyword search + monitored beauty subreddits, posts + comment sample | `APIFY_REDDIT_ACTOR_ID`, defaults to `trudax/reddit-scraper-lite` |
| Google Trends | Search-interest validation per canonical trend (AU + global), run *after* clustering | `APIFY_GOOGLE_TRENDS_ACTOR_ID` -- no official free API exists, so this is the most likely field-mapping to need adjustment at Phase 0 |

All actor IDs are one-line env var overrides so a deprecated/renamed actor doesn't require touching the ingestion pipeline (see `.env.example`) -- same pattern as this account's other Apify-backed dashboards.

Comment sampling: a shallow sample (`APIFY_SHALLOW_COMMENT_LIMIT`, default 15) for keyword-search results, a deeper sample (`APIFY_DEEP_COMMENT_LIMIT`, default 60) for monitored subreddits -- tunable in Admin → Score weights & thresholds (`comment_sampling` key) without a redeploy.

## 5. Scoring model

See `src/scoring.js` for the full, commented implementation. In short:

- **Trend age / active days / consecutive active days / days since peak** are computed from `trend_daily_metrics`, which is itself built from `post_metric_snapshots` (one row per post per day -- never overwritten) so velocity and "is this resurfacing or genuinely new" are both answerable.
- **Lifecycle stage** (new signal / emerging / accelerating / peaking / sustained / cooling / recurring-seasonal) and **durability label** (flash / early / validated / sustained / established) are separate fields, both rule-based against admin-editable thresholds.
- **Social Opportunity**, **Buying Opportunity** and **Confidence** are three independent 0-100 scores, each built from named, weighted components (log/percentile-scaled so one viral post or one dominant creator can't flatten every other topic), with saturation and safety penalties. Every component carries a plain-language explanation string, surfaced as "Why this score?" on the Trend Detail page.
- Platform metrics are **never summed into one misleading cross-platform total** -- TikTok plays, Instagram plays, Reddit discussion volume and the Google Trends index are always shown separately, including in the Compare view.

## 6. Auth model (MVP)

A single shared access password (`APP_ACCESS_PASSWORD`) gates sign-in; the signed-in email decides role (`ADMIN_EMAILS` → admin, everyone else → standard client, matching the doc's "separate administrator and standard client permissions" requirement). Sessions are a signed HMAC cookie, no external session store. This is intentionally lightweight for an MVP review build -- swap for real SSO (Google Workspace, Okta, etc.) before a wider production rollout, per the doc's security/privacy section.

## 7. Deploy to Render

`render.yaml` provisions a web service, a daily cron job (`node src/ingest.js`, scheduled for well before the AU business day), and a Postgres database in one Blueprint. Fill in `APIFY_TOKEN`, `ANTHROPIC_API_KEY` and `APP_ACCESS_PASSWORD` in the `sportsgirl-beauty-radar-secrets` env var group after the first deploy.

## 8. Extending later (Phase 2/3, per the doc's own roadmap)

- Wire the product-catalogue CSV import UI (data model + match API already exist).
- Feed published social performance and buyer decisions back in to improve future recommendations (Phase 3 -- "learning and commercial validation").
- Add the weekly digest + threshold-crossing alert emails (Phase 2) -- follow the pattern already used in this account's other dashboards (Resend-based digest, gated by a `should send` check) once alert fatigue thresholds are agreed with Sportsgirl.
- Promote a Claude-discovered alias to a monitored query with one click once an admin approves it (the `discovery_queries.status = 'pending_review'` path exists in the schema/API; clustering doesn't yet write new pending queries automatically).
