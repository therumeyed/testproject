# Melbourne Airport Mentions Dashboard

Tracks mentions of "Melbourne Airport" and stores them in Postgres, refreshed once a day. Sources:

| Source | What it finds | Access needed |
|---|---|---|
| Reddit | Posts (not comments) from specific communities only — `APIFY_REDDIT_SUBREDDITS`, defaults to r/melbourne + r/australia — filtered locally by keyword | Apify token |
| YouTube | Videos matching the search term | Apify token |
| Web / Facebook / Instagram / LinkedIn search | Public, Google-indexed posts/pages matching `site:facebook.com`, `site:instagram.com`, `site:linkedin.com`, and general web results | Apify token |
| Facebook (direct) | Public posts whose text matches the search phrase, found via Facebook's own search (logged-out) | Apify token |
| Instagram (hashtag) | Public posts tagged with the configured hashtag(s) — Instagram has no free-text post search, hashtag is the closest real capability | Apify token |
| Google reviews | New reviews (rating, text, translated text) across MelAir's Google Business Profile car park listings (currently 6 configured), one row per listing per review | Apify token + Place IDs |
| Facebook (MelAir's own Page) | All comments on MelAir's own Facebook posts | Page access token from MelAir |
| Instagram (MelAir's own account) | All comments on MelAir's own Instagram posts | Business account access token from MelAir |

Reddit, YouTube, and the search sources run through [Apify](https://apify.com) actors (third-party scrapers) rather than each platform's own official API. Worth knowing: these are community-maintained scrapers, not a versioned platform contract — the specific actor an integration uses could get renamed, change its input/output fields, or be deprecated by its maintainer with little notice. Each actor ID is a one-line env var override (see §2) precisely so a swap doesn't require touching the ingestion pipeline, just the field-mapping in that one source file if the replacement's output shape differs. If a source suddenly starts returning zero results, check the actor's Apify Store page first.

**On the direct Facebook/Instagram sources specifically:** these scrape the platforms directly rather than going through Google's index or an official API. Legally this is on firmer ground than it used to be — *Meta v. Bright Data* (Jan 2024) found Meta's Terms only bind an actively logged-in account, so logged-out scraping of public data (how these actors work — no login) isn't a contract breach; Meta dropped the case and waived appeal. That's one court's ruling, not a blanket guarantee, and it doesn't stop Meta from blocking or rate-limiting at the technical level. In practice, expect these two to be the **least reliable** sources in the pipeline — Meta runs some of the most aggressive anti-bot defenses of any platform, and open-ended keyword/hashtag search is the most fragile category of request (versus scraping one known Page or post). Runs may come back empty or partial sometimes; that's expected, not necessarily broken.

**Only new content is ever stored.** Each daily run looks at roughly the last 24 hours; nothing is backfilled. Search-engine results are deduped by URL, so once we've stored a link it won't reappear even if it keeps showing up in later searches — matching "first time we saw it" rather than "when it was actually posted" for sources where Google doesn't reliably expose a post date.

## What this does *not* cover (by platform policy, not something more dev time fixes)
- Comments on **other people's or other Pages'** Facebook/Instagram/LinkedIn posts about the airport — only MelAir's own posts are reachable for comment-level data.
- Instagram posts that mention the airport in text/caption but aren't tagged with a tracked hashtag — there's no free-text post search on Instagram to fall back on.
- LinkedIn posts from personal (non-professional) accounts — only what Google has indexed, which skews toward Pages/professional content.
- Anything older than when this dashboard went live — by design, per your "no old data" requirement.

## 1. Local setup

```bash
npm install
cp .env.example .env   # fill in DATABASE_URL and whichever API keys you have
npm start               # runs the dashboard at http://localhost:3000
npm run ingest           # runs one ingestion pass manually
```

You need a local or hosted Postgres instance for `DATABASE_URL`. Tables are created automatically on first run — no migration step.

## 2. Getting each API key

**Apify** (powers Reddit, YouTube, all the `site:` searches, the direct Facebook/Instagram sources, and Google reviews) — sign up at https://apify.com, go to Settings → Integrations, copy the API token → put it in `APIFY_TOKEN`. One token covers all six actors. Apify bills per actor run (compute + result volume); at this scale (a handful of keywords/hashtags/place IDs checked once a day) this should land in the low tens of dollars a month, but check current pricing on each actor's Store page before committing — community actor pricing isn't fixed the way an official API's is, and the Facebook search actor specifically caps free-tier results at 20/run (see its Store page for paid tiers). One operational note from getting this running: some actors require a one-time "rent"/subscribe click on their Store page before API access works, even with a valid token — if a source fails with `actor-is-not-rented`, that's what's happening.

Default actors used (overridable via `APIFY_REDDIT_ACTOR_ID`, `APIFY_YOUTUBE_ACTOR_ID`, `APIFY_GOOGLE_SEARCH_ACTOR_ID`, `APIFY_FACEBOOK_ACTOR_ID`, `APIFY_INSTAGRAM_ACTOR_ID`, `APIFY_GOOGLE_REVIEWS_ACTOR_ID` — see `.env.example`):
- Reddit: [`trudax/reddit-scraper-lite`](https://apify.com/trudax/reddit-scraper-lite), pay-per-result (~$3.40/1,000). Scoped to `APIFY_REDDIT_SUBREDDITS` (default `melbourne,australia`) rather than a site-wide search — pulls each community's newest posts and filters by keyword locally, which keeps cost bounded and predictable. Add more communities anytime, comma-separated, no code change needed.
- YouTube: [`streamers/youtube-scraper`](https://apify.com/streamers/youtube-scraper)
- Google search: [`apify/google-search-scraper`](https://apify.com/apify/google-search-scraper) (official Apify actor, not a community one — the most stable of the six)
- Facebook direct search: [`scrapeforge/facebook-search-posts`](https://apify.com/scrapeforge/facebook-search-posts)
- Instagram hashtag search: [`instaprism/instagram-hashtag-posts`](https://apify.com/instaprism/instagram-hashtag-posts) — set `APIFY_INSTAGRAM_HASHTAGS` (comma-separated, no `#`) to whichever hashtags are actually worth tracking; it defaults to a slugified `SEARCH_QUERY` (`melbourneairport`) if unset, which may not match what people actually tag posts with.
- Google reviews: [`compass/google-maps-reviews-scraper`](https://apify.com/compass/google-maps-reviews-scraper), very cheap (~$0.05/1,000 reviews).

**Google Business Profile reviews** need `APIFY_GOOGLE_PLACE_IDS` — a comma-separated identifier per car park listing (6 currently configured for MelAir). This works entirely off public identifiers, no Google approval needed, which is why it's the primary path here rather than Google's official Business Profile API. That official API does exist and would let you *reply* to reviews (this Apify path is read-only), but requires applying for access — Google's own approval process typically takes days to weeks and needs each listing to be a verified profile active 60+ days. Worth applying for in parallel if a reply workflow becomes a requirement later, but too slow to gate this dashboard on.

The env var accepts either identifier type, auto-detected:
- **A numeric CID** — the easiest source if you already manage the listing: open it in [Business Profile Manager](https://business.google.com/), the URL is `business.google.com/n/.../profile?fid=NNNNN` — that `fid` number *is* the CID. Verified working this way. (A Maps "Share" link did **not** work with this actor — its short-URL redirect isn't followed, so don't use those.)
- **A standard Place ID** (`ChIJ...`) — from [Google's Place ID Finder](https://developers.google.com/maps/documentation/places/web-service/place-id), if you'd rather not need Business Profile Manager access for a listing.

Each review in the dashboard shows which listing it's for (`title` includes the business name + star rating) since MelAir has multiple car park products under separate profiles.

**Facebook (MelAir's own Page comments)** — this needs someone who administers MelAir's Facebook Page. Steps to hand to the MelAir team:
1. In [Meta Business Suite](https://business.facebook.com/) → Business Settings, add the developer (you) as a **Partner** with access to the Page, or create a **System User** with access to the Page if MelAir already uses Business Manager.
2. Create a Meta App at https://developers.facebook.com/apps (type: Business).
3. Generate a **Page Access Token** for the airport's Page with the `pages_read_engagement` permission (Graph API Explorer, or via the System User).
4. Send you the Page ID and the access token → put them in `FB_PAGE_ID` / `FB_PAGE_ACCESS_TOKEN`.

Note: short-lived tokens expire quickly — ask for (or generate) a **long-lived Page token**, or use a System User token, which doesn't expire on a fixed schedule.

**Instagram (MelAir's own account comments)** — only works if their Instagram is a **Business or Creator account** linked to their Facebook Page (almost certainly already true for an official airport account).
1. Same Meta App as above, add the `instagram_basic` and `instagram_manage_comments` permissions.
2. Get the Instagram Business Account ID (via Graph API Explorer: `GET /{page-id}?fields=instagram_business_account`) and an access token with those permissions.
3. Send you both → put them in `IG_BUSINESS_ACCOUNT_ID` / `IG_ACCESS_TOKEN`.

Until these two are provided, those two sources just log a skip message and the rest of the dashboard works fine.

**LinkedIn** — the public `site:linkedin.com` search is already included via the Apify Google search actor, no separate setup needed. Pulling comments from MelAir's own LinkedIn Company Page is not built in this version: LinkedIn's Community Management API requires applying to their Marketing Developer Program, which has a slower, less predictable approval process than Meta's. Worth adding later if it's approved, but not assumed here.

## 3. Deploy to Render

This repo includes `render.yaml`, so Render can provision everything from one Blueprint:

1. Push this repo to GitHub (already done if you're reading this from the branch).
2. In Render, choose **New → Blueprint**, point it at this repo/branch. It will create:
   - a **web service** (the dashboard, `melair-mentions-dashboard`)
   - a **cron job** (`melair-mentions-ingest`, runs 3x/day — 9am, 1pm, 5pm Melbourne time)
   - a **Postgres database** (`melair-mentions-db`), wired to both automatically via `DATABASE_URL`
3. Render will prompt you for the values in the `melair-mentions-secrets` group (`APIFY_TOKEN`, `APIFY_GOOGLE_PLACE_IDS`, and the Facebook/Instagram keys) — fill in what you have now, add the rest later once you have them (Environment → edit the group → redeploy, no code changes needed).
4. Once deployed, open the web service's URL to see the dashboard.

**Cron schedule:** `render.yaml`'s `schedule` field is UTC-only — Render has no timezone/DST awareness. The current value (`0 23,3,7 * * *`) hits 9am/1pm/5pm Melbourne time during AEST (UTC+10, roughly Apr-Oct). During AEDT (UTC+11, roughly Oct-Apr) it'll fire an hour early local time unless shifted to `0 22,2,6 * * *` — worth updating at each daylight-saving change, there's a comment in the file with both values.

**Running 3x/day roughly triples the Apify actor spend** versus once/day — most of these actors bill per run or per result regardless of whether anything new turns up, so three checks means paying for three fetches even on runs that find nothing. Worth keeping an eye on Apify's usage dashboard after the first week at this cadence.

**Email behavior at this cadence:** the dashboard/database refresh on all three daily runs, but email volume is intentionally decoupled from that:
- **Urgent alert** — real-time, sent on *any* run (9am, 1pm, or 5pm) that finds a high-severity negative mention.
- **Daily digest** — genuinely once/day, sent only on the last (5pm-ish) run, aggregating every negative mention first seen anywhere across *all* of that day's runs — not just the triggering run's own findings. Determined by checking the current Melbourne wall-clock hour (`isDigestRun()` in `ingest.js`), since Render doesn't pass any run-identifying info to the script. Known limitation: if that specific run fails outright, no digest goes out that day (it doesn't fall back to an earlier run).

## 4. Sentiment classification and email alerts

Every newly-inserted mention (never re-classified once done, matching the "only new content" rule elsewhere) is classified by Claude into `negative` / `neutral` / `positive`, with a `low` / `medium` / `high` severity and a one-line reason for negatives. This runs by meaning, not a keyword list — e.g. "kind of a hassle now" is correctly flagged negative even with no explicit negative word — which was the point of picking it over a free keyword-based approach.

Two emails come out of each daily run, both via [Resend](https://resend.com):
- **Urgent alert** — sent immediately (i.e. same run) if any mention classified `high` severity is found. Marks each as alerted (`alerted_at`) so it's never re-sent for the same mention.
- **Daily digest** — always sent once per run, listing every `negative` mention found that day (all severities), grouped with source/severity/link/reason. Sent even when there's nothing negative (says so explicitly) — doubles as a quiet confirmation the pipeline ran, not just a complaints feed.

**Setup:**
1. **Anthropic** — get a key at https://console.anthropic.com → `ANTHROPIC_API_KEY`. Uses Haiku by default (`ANTHROPIC_MODEL` to override); cheap at this volume — classification is batched (20 mentions/request), typically a few requests per day.
2. **Resend** — sign up at https://resend.com **using `nitin@alleygroup.com.au` as the account email** (or whichever address should receive the first test) → `RESEND_API_KEY`. This matters: Resend's sandbox sender (`onboarding@resend.dev`, the default `EMAIL_FROM`) only delivers to the address the account signed up with until a domain is verified — sending to a different address will silently go nowhere. `ALERT_EMAIL_TO` accepts a comma-separated list; currently defaults to `nitin@alleygroup.com.au` per the initial test request.
3. **For production** (multiple recipients, e.g. MelAir's ops team, and a proper sender address) — verify a domain under Resend → Domains (adds SPF/DKIM/DMARC DNS records to a domain you control, e.g. the agency's), then set `EMAIL_FROM` to an address on that domain and add every real recipient to `ALERT_EMAIL_TO`.

Both are skipped gracefully without their keys set — same pattern as every other source in this pipeline — so the rest of the dashboard keeps working either way.

The dashboard itself shows a sentiment badge per mention, sentiment summary tiles, and a sentiment filter (including "Negative only") on top of the existing source/date filters.

## 5. Extending later
- Issue-category tagging (signage, pricing, shuttle, staff, accessibility) could be added to the same classification pass with one more field in the prompt — `raw_data` JSONB is kept on every row either way, so nothing needs re-pulling to add this.
- Slack alerting is a small addition alongside the Resend call in `ingest.js` if email turns out to be too slow for urgent alerts.
