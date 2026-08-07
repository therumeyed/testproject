# Melbourne Airport Mentions Dashboard

Tracks mentions of "Melbourne Airport" and stores them in Postgres, refreshed once a day. Sources:

| Source | What it finds | Access needed |
|---|---|---|
| Reddit | Posts (not comments — Reddit's API doesn't support full-text comment search) | Free Reddit app credentials |
| YouTube | Videos matching the search term | Free Google API key |
| Web / Facebook / Instagram / LinkedIn search | Public, Google-indexed posts/pages matching `site:facebook.com`, `site:instagram.com`, `site:linkedin.com`, and general web results | SerpApi key (paid, cheap at this volume) |
| Facebook (MelAir's own Page) | All comments on MelAir's own Facebook posts | Page access token from MelAir |
| Instagram (MelAir's own account) | All comments on MelAir's own Instagram posts | Business account access token from MelAir |

**Only new content is ever stored.** Each daily run looks at roughly the last 24 hours; nothing is backfilled. Search-engine results are deduped by URL, so once we've stored a link it won't reappear even if it keeps showing up in later searches — matching "first time we saw it" rather than "when it was actually posted" for sources where Google doesn't reliably expose a post date.

## What this does *not* cover (by platform policy, not something more dev time fixes)
- Comments on **other people's or other Pages'** Facebook/Instagram/LinkedIn posts about the airport — only MelAir's own posts are reachable for comment-level data.
- Instagram/Facebook/LinkedIn posts from personal (non-professional) accounts — search engines mostly only index Pages and professional/business accounts.
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

**Reddit** — go to https://www.reddit.com/prefs/apps → "create app" → choose type **"web app"** → note the client ID (under the app name) and secret. Free, no approval wait. Put them in `REDDIT_CLIENT_ID` / `REDDIT_CLIENT_SECRET`.

**YouTube** — in [Google Cloud Console](https://console.cloud.google.com/), create/select a project → enable **"YouTube Data API v3"** → Credentials → create an API key. Free (10,000 quota units/day, this app uses ~100/run). Put it in `YOUTUBE_API_KEY`.

**SerpApi** (powers all the `site:` searches) — sign up at https://serpapi.com, grab the API key from the dashboard. Paid, but at one keyword run once a day this is a few dollars a month at most. Put it in `SERPAPI_KEY`.

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

**LinkedIn** — the public `site:linkedin.com` search is already included via SerpApi, no separate setup needed. Pulling comments from MelAir's own LinkedIn Company Page is not built in this version: LinkedIn's Community Management API requires applying to their Marketing Developer Program, which has a slower, less predictable approval process than Meta's. Worth adding later if it's approved, but not assumed here.

## 3. Deploy to Render

This repo includes `render.yaml`, so Render can provision everything from one Blueprint:

1. Push this repo to GitHub (already done if you're reading this from the branch).
2. In Render, choose **New → Blueprint**, point it at this repo/branch. It will create:
   - a **web service** (the dashboard, `melair-mentions-dashboard`)
   - a **cron job** (`melair-mentions-ingest`, runs daily at 20:00 UTC ≈ 6-7am Melbourne)
   - a **Postgres database** (`melair-mentions-db`), wired to both automatically via `DATABASE_URL`
3. Render will prompt you for the values in the `melair-mentions-secrets` group (Reddit/YouTube/SerpApi/Facebook/Instagram keys) — fill in what you have now, add the Facebook/Instagram ones later once MelAir sends them (Environment → edit the group → redeploy, no code changes needed).
4. Once deployed, open the web service's URL to see the dashboard.

To change the daily run time, edit the `schedule` cron expression in `render.yaml` (it's UTC).

## 4. Extending later
- Sentiment/issue categorization isn't built in this version — the `raw_data` JSONB column on every row keeps the full original API response, so this can be layered on without re-pulling anything.
- Slack/email alerting on spikes or negative content is a small addition on top of `/api/stats` once categorization exists.
