# Melbourne Airport Mentions Dashboard

Tracks mentions of "Melbourne Airport" and stores them in Postgres, refreshed once a day. Sources:

| Source | What it finds | Access needed |
|---|---|---|
| Reddit | Posts (not comments — no scraper here gets full-text search of arbitrary comments either) | Apify token |
| YouTube | Videos matching the search term | Apify token |
| Web / Facebook / Instagram / LinkedIn search | Public, Google-indexed posts/pages matching `site:facebook.com`, `site:instagram.com`, `site:linkedin.com`, and general web results | Apify token |
| Facebook (direct) | Public posts whose text matches the search phrase, found via Facebook's own search (logged-out) | Apify token |
| Instagram (hashtag) | Public posts tagged with the configured hashtag(s) — Instagram has no free-text post search, hashtag is the closest real capability | Apify token |
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

**Apify** (powers Reddit, YouTube, all the `site:` searches, and the direct Facebook/Instagram sources) — sign up at https://apify.com, go to Settings → Integrations, copy the API token → put it in `APIFY_TOKEN`. One token covers all five actors. Apify bills per actor run (compute + result volume); at one keyword/hashtag checked once a day this should land in the low tens of dollars a month, but check current pricing on each actor's Store page before committing — community actor pricing isn't fixed the way an official API's is, and the Facebook search actor specifically caps free-tier results at 20/run (see its Store page for paid tiers).

Default actors used (overridable via `APIFY_REDDIT_ACTOR_ID`, `APIFY_YOUTUBE_ACTOR_ID`, `APIFY_GOOGLE_SEARCH_ACTOR_ID`, `APIFY_FACEBOOK_ACTOR_ID`, `APIFY_INSTAGRAM_ACTOR_ID` — see `.env.example`):
- Reddit: [`trudax/reddit-scraper`](https://apify.com/trudax/reddit-scraper)
- YouTube: [`streamers/youtube-scraper`](https://apify.com/streamers/youtube-scraper)
- Google search: [`apify/google-search-scraper`](https://apify.com/apify/google-search-scraper) (official Apify actor, not a community one — the most stable of the five)
- Facebook direct search: [`scrapeforge/facebook-search-posts`](https://apify.com/scrapeforge/facebook-search-posts)
- Instagram hashtag search: [`instaprism/instagram-hashtag-posts`](https://apify.com/instaprism/instagram-hashtag-posts) — set `APIFY_INSTAGRAM_HASHTAGS` (comma-separated, no `#`) to whichever hashtags are actually worth tracking; it defaults to a slugified `SEARCH_QUERY` (`melbourneairport`) if unset, which may not match what people actually tag posts with.

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
   - a **cron job** (`melair-mentions-ingest`, runs daily at 20:00 UTC ≈ 6-7am Melbourne)
   - a **Postgres database** (`melair-mentions-db`), wired to both automatically via `DATABASE_URL`
3. Render will prompt you for the values in the `melair-mentions-secrets` group (`APIFY_TOKEN` and the Facebook/Instagram keys) — fill in what you have now, add the Facebook/Instagram ones later once MelAir sends them (Environment → edit the group → redeploy, no code changes needed).
4. Once deployed, open the web service's URL to see the dashboard.

To change the daily run time, edit the `schedule` cron expression in `render.yaml` (it's UTC).

## 4. Extending later
- Sentiment/issue categorization isn't built in this version — the `raw_data` JSONB column on every row keeps the full original API response, so this can be layered on without re-pulling anything.
- Slack/email alerting on spikes or negative content is a small addition on top of `/api/stats` once categorization exists.
