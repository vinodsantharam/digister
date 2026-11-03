# Digister build tasks (free-only, v1)

Decided 2026-11-03. Budget is zero: no paid X API, no third-party APIs, no paid YouTube API use, no YouTube transcripts.
Each task below is self-contained enough to hand to a coding sub-agent. Do them in order; each lists what to build, the files, and how to tell it is done.

## Decisions every task must respect

- **Runtime:** Node.js 22 LTS, TypeScript (strict), ES modules, `npm`. Run TypeScript with `tsx`; no bundler.
- **LLM:** Ollama on `http://localhost:11434`, called through the Vercel AI SDK (`ai` package) with an Ollama provider (`ollama-ai-provider-v2`, or `@ai-sdk/openai-compatible` pointed at `http://localhost:11434/v1` if that provider does not support the installed `ai` major version). Default chat model `qwen3:8b`, configurable. All structured output goes through Zod schemas.
- **X source (free):** Playwright drives a persistent Chromium profile that the user logged into once by hand. Digister opens the user's X List page (and optionally the "Following" timeline) and **reads the JSON the X web app itself receives**, by listening to network responses whose URL contains `/graphql/` and whose operation name matches a configured list. It never builds or signs X API requests itself, so X's rotating query IDs and request signing do not matter. This uses the user's own account and is against X's terms of service; the user has accepted that risk. Keep it gentle: one session per run, at most one run per day by default, no parallel tabs, realistic scrolling with pauses.
- **YouTube source (free):** public channel RSS feeds `https://www.youtube.com/feeds/videos.xml?channel_id=<ID>`; no API key, no OAuth. YouTube Premium gives no API benefit and is not used. No transcripts: the title, description, channel, and publish time are the inputs.
- **Optional, still free:** a YouTube Data API v3 *API key* (no OAuth, free quota) may be set to fetch durations and view counts with `videos.list`. Everything must work without it.
- **Storage:** SQLite via `better-sqlite3`, one file at `~/.digister/digister.db`. All state (profile, db, logs, output) lives under `~/.digister/` unless overridden by `DIGISTER_HOME`.
- **Output:** one self-contained HTML file per day, `digest-YYYY-MM-DD.html`, no JavaScript, inline CSS, written to a configured output folder (a phone-synced folder).
- **Libraries:** `commander` (CLI), `zod`, `yaml`, `fast-xml-parser`, `better-sqlite3`, `playwright`, `react` + `react-dom` (server rendering only), `vitest` (tests), `pino` (logs). Pin exact versions in `package.json` after install.
- **Code style:** small modules, no classes unless needed, every network call has a timeout, every external payload is parsed with Zod or a defensive parser. Unit tests use recorded fixtures, never the live network.

## Target layout

```
digister/
  package.json  tsconfig.json  vitest.config.ts
  config/
    interests.example.yaml
    channels.example.yaml
    digister.example.yaml
  src/
    cli.ts
    config.ts
    paths.ts
    log.ts
    store/db.ts
    store/schema.sql
    sources/youtube/rss.ts
    sources/youtube/channels.ts
    sources/youtube/enrich.ts
    sources/x/browser.ts
    sources/x/capture.ts
    sources/x/parse.ts
    llm/client.ts
    llm/schemas.ts
    pipeline/score-videos.ts
    pipeline/score-posts.ts
    pipeline/select.ts
    pipeline/run.ts
    render/Digest.tsx
    render/styles.ts
    render/write.ts
  test/
    fixtures/youtube-feed.xml
    fixtures/x-list-timeline.json
    *.test.ts
  scripts/
    install-schedule-macos.sh
    install-schedule-linux.sh
    install-schedule-windows.ps1
```

---

## T1. Project skeleton

Build:
- `package.json` with `"type": "module"`, `bin: { "digister": "./bin/digister.mjs" }`, scripts `dev` (`tsx src/cli.ts`), `test` (`vitest run`), `typecheck` (`tsc --noEmit`), `lint` (optional).
- `bin/digister.mjs` that runs `src/cli.ts` through `tsx`.
- `tsconfig.json`: strict, `module` and `moduleResolution` `NodeNext`, `jsx` `react-jsx`, target ES2022.
- `src/paths.ts`: resolves `DIGISTER_HOME` (default `~/.digister`) and the paths for `digister.db`, `x-profile/`, `logs/`, `raw/` (captured payloads), and creates them if missing.
- `src/log.ts`: a `pino` logger writing to stdout and to `logs/digister-YYYY-MM-DD.log`.
- `src/cli.ts` with `commander` and these subcommands, each printing "not implemented" for now: `run`, `run --dry`, `x login`, `x check`, `youtube import`, `youtube check`, `doctor`.
- `.gitignore` additions: `node_modules`, `.env`, `out/`, `*.db`.

Done when: `npm install`, `npm run typecheck`, `npm test` (zero tests passes) and `npx tsx src/cli.ts --help` all succeed.

## T2. Configuration

Build `src/config.ts` that loads three YAML files from `DIGISTER_HOME/config/` (falling back to `./config/`) and validates them with Zod. Ship `*.example.yaml` versions in `config/`.

`digister.yaml`:
```yaml
output_dir: "~/Library/Mobile Documents/com~apple~CloudDocs/Digister"   # any folder synced to the phone
ollama:
  base_url: "http://localhost:11434"
  chat_model: "qwen3:8b"
x:
  enabled: true
  list_urls: ["https://x.com/i/lists/1234567890"]
  include_following: false        # also read the Following (chronological) timeline
  max_posts_per_run: 300
  lookback_hours: 30
  headless: true
  graphql_operations: ["ListLatestTweetsTimeline", "HomeLatestTimeline", "TweetDetail"]
youtube:
  lookback_hours: 36
  data_api_key: ""               # optional, free; leave empty to skip enrichment
digest:
  must_watch_max: 3
  posts_max: 20
  reading_minutes: 25
```

`channels.yaml` (the user's channels; `tier` drives priority):
```yaml
channels:
  - id: "UCxxxxxxxxxxxxxxxxxxxxxx"
    name: "Example channel"
    tier: must        # must | high | normal
```

`interests.yaml`:
```yaml
topics:
  - name: "Local AI and agents"
    weight: 1.0
    description: "open-weight model releases, agent frameworks, running LLMs locally"
mute: ["giveaway", "engagement bait"]
```

Expand `~` in paths. Fail with a clear message naming the file and field on validation errors.

Done when: unit tests load the example files successfully and reject a file with a missing `output_dir` and a channel with an invalid `tier`.

## T3. SQLite store

Build `src/store/schema.sql` and `src/store/db.ts` (opens the db, applies the schema idempotently, exports typed helpers).

Tables:
- `videos(id TEXT PRIMARY KEY, channel_id, channel_name, title, description, url, thumbnail_url, published_at TEXT, duration_s INTEGER NULL, view_count INTEGER NULL, is_short INTEGER NULL, first_seen_at TEXT, score REAL NULL, reason TEXT NULL, scored_at TEXT NULL, shown_in TEXT NULL)`
- `posts(id TEXT PRIMARY KEY, author_handle, author_name, text, url, created_at TEXT, lang, reply_to_id NULL, quoted_id NULL, conversation_id NULL, like_count INTEGER, repost_count INTEGER, media_json TEXT, links_json TEXT, source TEXT, first_seen_at TEXT, score REAL NULL, topic TEXT NULL, summary TEXT NULL, scored_at TEXT NULL, shown_in TEXT NULL)`
- `runs(id INTEGER PRIMARY KEY, started_at, finished_at NULL, status, x_posts_seen INTEGER, videos_seen INTEGER, digest_path NULL, error NULL)`

Helpers: `upsertVideo`, `upsertPost` (insert or ignore on id, keep the first `first_seen_at`), `unscoredVideos(sinceIso)`, `unscoredPosts(sinceIso)`, `setVideoScore`, `setPostScore`, `markShown(kind, ids, digestDate)`, `startRun`, `finishRun`.

Done when: tests against an in-memory db cover upsert idempotency and that an item marked shown is excluded from the next selection query.

## T4. YouTube: channel import

Build `src/sources/youtube/channels.ts` and the `youtube import` command.

- `digister youtube import --takeout <path/to/subscriptions.csv>` reads a Google Takeout subscriptions CSV (columns: Channel Id, Channel Url, Channel Title) and appends channels missing from `channels.yaml` with `tier: normal`. It never removes or re-tiers existing entries.
- `digister youtube import --url <channel URL or @handle>` resolves one channel: fetch the channel page HTML and read the `channelId` (from `<link rel="canonical" href=".../channel/UC...">` or the `"channelId":"UC..."` JSON); add it with the tier given by `--tier` (default `must`).
- Write `channels.yaml` back preserving comments where feasible (use the `yaml` package's Document API).

Done when: a test with a sample Takeout CSV adds the right channels without duplicates; a test with a saved channel-page HTML fixture extracts the channel id.

## T5. YouTube: RSS collector

Build `src/sources/youtube/rss.ts`.

- For each channel in `channels.yaml`, GET `https://www.youtube.com/feeds/videos.xml?channel_id=<ID>` with a 15 s timeout, at most 4 requests in parallel, a normal desktop User-Agent string, and one retry on network error.
- Parse with `fast-xml-parser`. Each `<entry>` gives `yt:videoId`, `title`, `published`, `author/name`, `media:group/media:description`, `media:group/media:thumbnail@url`, and `link@href`.
- Detect Shorts heuristically when the link contains `/shorts/`; otherwise leave `is_short` null.
- Keep only entries published within `youtube.lookback_hours`; upsert into `videos`.
- A failing channel is logged and skipped; the run continues.

Done when: a test parses `test/fixtures/youtube-feed.xml` (record a real feed into the fixture) into the expected objects, and `digister youtube check` prints the newest video per channel.

## T6. YouTube: optional enrichment

Build `src/sources/youtube/enrich.ts`. Only runs when `youtube.data_api_key` is set.

- Batch up to 50 ids per call to `https://www.googleapis.com/youtube/v3/videos?part=contentDetails,statistics&id=...&key=...`.
- Parse ISO 8601 durations (`PT1H2M3S`) to seconds; set `duration_s`, `view_count`, and `is_short = duration_s <= 180` when it was null.
- On any API error, log and continue without enrichment.

Done when: tests cover the duration parser and a recorded response fixture.

## T7. X: login and browser session

Build `src/sources/x/browser.ts` and the `x login` / `x check` commands.

- Use `chromium.launchPersistentContext(<DIGISTER_HOME>/x-profile, { headless, viewport: { width: 1280, height: 900 }, locale: "en-US" })`.
- `digister x login` always launches headed, opens `https://x.com/login`, prints "Log in in the browser window, then press Enter here", waits for Enter, then verifies login by checking that the `auth_token` cookie exists for `.x.com`, and closes.
- `digister x check` launches with the configured `headless`, loads `https://x.com/home`, and reports logged in, logged out (redirected to a login URL or no `auth_token`), or blocked (challenge page or HTTP 4xx), with a non-zero exit code for the last two.
- Never store or print cookie values. Never type the user's password.

Done when: run manually by the user (needs a real account). Unit tests only cover the state-detection function against saved HTML snippets.

## T8. X: capture timeline JSON

Build `src/sources/x/capture.ts`.

- Open one page per configured URL (each `list_urls` entry, plus `https://x.com/home` with the "Following" tab selected when `include_following` is true), one at a time in the same context.
- Before navigating, attach `page.on("response")`. Keep a response when its URL contains `/graphql/`, the path's last segment (the operation name) is in `x.graphql_operations`, and the status is 200. Save each JSON body to `raw/x/YYYY-MM-DD/<operation>-<n>.json` and pass it to the parser (T9).
- Scroll like a person: `mouse.wheel` by 600 to 1,200 px, wait a random 1.5 to 4 s, repeat until one of: the oldest parsed post is older than `lookback_hours`, `max_posts_per_run` posts have been parsed, 40 scrolls, or 3 scrolls in a row add no new posts.
- Total time cap per run: 4 minutes. On a login redirect or challenge page, stop, mark the run's X part as `needs_login`, and continue the digest with YouTube only.
- If the configured operation names never appear, log the `/graphql/` operation names that were seen, so the config can be updated without code changes.

Done when: a test drives the capture logic with a fake page object that emits recorded responses and checks the stop conditions. Live behavior is verified manually.

## T9. X: parse timeline payloads

Build `src/sources/x/parse.ts`, a pure function `parseTimeline(json): Post[]`.

- Walk the JSON recursively rather than hard-coding one path; collect every object that has `__typename === "Tweet"` (or `TweetWithVisibilityResults`, whose `.tweet` holds the tweet).
- From each tweet read: `rest_id`; text from `note_tweet.note_tweet_results.result.text` if present, else `legacy.full_text`; `legacy.created_at` (format `Wed Oct 30 05:30:00 +0000 2026`, convert to ISO); `legacy.lang`; `legacy.favorite_count`; `legacy.retweet_count`; `legacy.in_reply_to_status_id_str`; `legacy.conversation_id_str`; `legacy.entities.urls[].expanded_url`; `legacy.extended_entities.media[]` (type and url).
- Author handle and name: read `core.user_results.result.core.screen_name` / `.name`, falling back to `core.user_results.result.legacy.screen_name` / `.name` (X moved these fields; support both).
- Retweets: if `legacy.retweeted_status_result.result` exists, parse that inner tweet instead and record `source = "repost by @handle"`.
- Quotes: parse `quoted_status_result.result` as its own post and set `quoted_id` on the outer one.
- Deduplicate by id. Skip promoted entries (entry ids starting with `promoted-` or objects with `promotedMetadata`).
- Build `url` as `https://x.com/<handle>/status/<id>`.

Done when: tests pass on at least two recorded fixtures (a List timeline and a Following timeline) captured by running T8 once; include a fixture with each of: long note tweet, retweet, quote, reply, and a promoted entry.

## T10. LLM client and schemas

Build `src/llm/client.ts` and `src/llm/schemas.ts`.

- `client.ts` exports `generateStructured<T>(schema, system, prompt)` using the AI SDK's structured output (`generateObject`, or the current equivalent) with the Ollama model from config, temperature 0.2, a 120 s timeout, and one retry on schema validation failure. Also export `ollamaHealthy()` that GETs `<base_url>/api/tags` and checks the chat model is pulled.
- `schemas.ts`:
  - `VideoScore = { id: string, score: number /*0-10*/, must_watch: boolean, reason: string /*max 140 chars*/ }`
  - `PostScore = { id: string, score: number, topic: string /* one of the interest names or "other" */, summary: string /*max 200 chars*/ }`
  - Each call scores a batch: `{ items: VideoScore[] }` or `{ items: PostScore[] }`.

Done when: a test with a mocked model (the AI SDK's mock provider) validates parsing and the retry path; `digister doctor` reports Ollama status and the model.

## T11. Score videos ("must watch today")

Build `src/pipeline/score-videos.ts`.

- Input: unscored videos from the lookback window, excluding Shorts unless the channel tier is `must`.
- Pre-rule: muted phrases in title or description drop the video (score 0, reason "muted").
- Send batches of 10 to `generateStructured` with: the interests (names, weights, descriptions), and per video: id, channel name, channel tier, title, the first 800 characters of the description, published time, and duration if known.
- System prompt essentials: "You pick what this person must watch today. Prefer videos that match their interests and come from their must-tier channels. Penalize clickbait titles, sponsorship-heavy descriptions, reuploads, and livestream replays. must_watch is true for at most 3 videos overall."
- Final score = model score + 2 for `must` tier, +1 for `high` tier, capped at 10. Store score and reason.

Done when: tests with a mocked model check the tier bonus, mute rule, Shorts exclusion, and batching.

## T12. Score X posts

Build `src/pipeline/score-posts.ts`.

- Input: unscored posts from the lookback window.
- Pre-rules: drop muted phrases; drop replies to other people unless the author is replying to themselves (thread); merge a self-thread (same `conversation_id`, same author) into one item whose text is the joined posts in order.
- Batches of 15 to `generateStructured` with interests and per post: id, author, text (max 1,000 chars), link domains, like and repost counts.
- System prompt essentials: "Score how worth reading each post is for this person today, 0 to 10. Reward original insight, news, and useful links in their interests. Penalize hot takes, engagement bait, and memes. Write a neutral one- or two-sentence summary."

Done when: tests with a mocked model cover thread merging, reply filtering, and mute.

## T13. Select digest content

Build `src/pipeline/select.ts`, pure functions.

- Videos: "Must watch today" = up to `must_watch_max` videos with `must_watch` true or score >= 8, best first; "Also new from your channels" = remaining videos from `must`/`high` tiers, newest first, max 10.
- Posts: best first by score until `posts_max` or the reading budget is reached (estimate 200 words per minute on summaries plus original text), grouped by topic in the order of `interests.yaml`.
- Never select items already marked shown in a previous digest.

Done when: unit tests cover limits, grouping order, and the shown exclusion.

## T14. Render the HTML digest

Build `src/render/Digest.tsx`, `src/render/styles.ts`, `src/render/write.ts`.

- Render with `react-dom/server` `renderToStaticMarkup`, prepend `<!doctype html>`, include `<meta charset="utf-8">` and `<meta name="viewport" content="width=device-width, initial-scale=1">`.
- Inline CSS only: system font stack, 18 px base, max width 680 px, single column, light and dark via `@media (prefers-color-scheme: dark)`, large tap targets.
- Sections in order: header (date, counts, estimated reading time, warnings such as "X needs login"); table of contents with anchors; "Must watch today" (thumbnail via `<img src>` pointing to the YouTube thumbnail URL with `loading="lazy"` and alt text, title linked to the video, channel, duration if known, the model's reason, the first 300 characters of the description); X posts grouped by topic (author, summary, original text in a collapsible `<details>`, link to the post); "Also new from your channels" as a compact list; footer with run time and items filtered.
- Escape all text (React does this; never use `dangerouslySetInnerHTML` with source text).
- `write.ts` writes `digest-YYYY-MM-DD.html` to `output_dir` atomically (write temp file, rename) and also refreshes `latest.html`.

Done when: a snapshot test renders a fixture digest; the HTML validates (no unclosed tags) and contains no `<script>`.

## T15. The run command

Build `src/pipeline/run.ts` and wire `digister run`.

Order: `ollamaHealthy()` (if down, try `ollama serve` once, wait 10 s, re-check; else fail with a clear message) → start run row → YouTube RSS (T5) → enrichment if a key is set (T6) → X capture (T8, skipped when disabled or logged out) → score videos (T11) → score posts (T12) → select (T13) → render and write (T14) → mark shown → finish run row.

- Each source failure is caught, logged, and shown as a warning in the digest header; the digest is still written.
- `--dry`: fetch nothing from X, read YouTube RSS, print counts and what would be scored; no LLM calls, no writes except logs.
- A lock file in `DIGISTER_HOME` prevents two runs at once.
- Exit code 0 when a digest was written, 1 otherwise.

Done when: an integration test with fixtures (mocked fetch, fake X capture, mocked model) produces an HTML file in a temp dir.

## T16. Scheduling scripts

Write the three scripts in `scripts/`, each installing a daily 05:30 job that runs `digister run` with the right `PATH` (Node and Ollama) and appends output to the log folder.

- macOS: a LaunchAgent plist at `~/Library/LaunchAgents/com.digister.run.plist` with `StartCalendarInterval` Hour 5 Minute 30, loaded with `launchctl bootstrap gui/$(id -u)`; print the optional `sudo pmset repeat wakeorpoweron MTWRFSU 05:25:00` command rather than running it.
- Linux: a systemd user service and timer with `OnCalendar=*-*-* 05:30:00` and `Persistent=true`, enabled with `systemctl --user enable --now`.
- Windows: `Register-ScheduledTask` with a daily 05:30 trigger and `-WakeToRun`.
- Each script supports `--uninstall`.

Done when: scripts pass `shellcheck` (bash) and are documented in the README; installation is tested manually by the user.

## T17. README and doctor

- `digister doctor` checks: Node version, config files valid, Ollama reachable and model pulled, output folder writable, X profile present and logged in (`x check`), number of channels, schedule installed (best effort per OS).
- README: what Digister does, the free-only approach and the X terms-of-service risk in plain words, setup steps in order (install Node and Ollama, `ollama pull qwen3:8b`, `npm install`, `npx playwright install chromium`, copy example configs, `digister youtube import`, `digister x login`, `digister run`, install the schedule), and troubleshooting (X operation names changed, logged out, Ollama down).

Done when: a fresh clone can follow the README to a first digest.

---

## Manual steps for the user (cannot be delegated)

1. Create a private X List with the 30 to 80 accounts you care about and paste its URL into `digister.yaml`.
2. Run `digister x login` once and log in in the browser window.
3. List your most important channels in `channels.yaml` with `tier: must` (or send them to Claude to add), and optionally import the rest from Google Takeout (YouTube and YouTube Music → subscriptions).
4. Choose the phone-synced output folder.
5. After the first run, capture fixtures for T9 if tests were written before real payloads existed.

## Known risks

- X can change its web app or flag automated reading; when capture stops working, `doctor` and the digest header say so, and YouTube keeps working.
- RSS feeds return only about the 15 newest videos per channel, which is enough for a daily run but means a machine that is off for weeks misses older uploads.
- Small local models misjudge some videos from the description alone; the must-tier bonus keeps your chosen channels on top.

## Implementation notes

Where the build diverged from the tasks above:

- **`videos.must_watch` column (T11/T13):** the schema has an extra `must_watch INTEGER` column so the model's flag, after the code-enforced cap of `must_watch_max`, survives until selection. `openDb` adds it to databases created before it existed.
- **Zero scores are never selected (T12/T13):** muted items, replies to others and posts merged into a thread get score 0 and are excluded by `select.ts`. A merged self-thread is stored in its first post (text joined).
- **Pinned posts (T8/T9):** `parseTimeline` marks tweets inside a `TimelinePinEntry` (or a `pinned-` entry id) with `pinned: true`; capture ignores them when checking the lookback.
- **Second run on the same day (T14):** `write.ts` writes `digest-YYYY-MM-DD-2.html` instead of overwriting the first digest; `latest.html` is refreshed either way.
- **`run --dry` (T15):** uses an in-memory database, so it also creates no `digister.db` and takes no lock. It does not check Ollama.
- **Not implemented:** "at most one run per day by default" (T-decisions) is not enforced; the lock only prevents overlapping runs.
- **Scripts (T16):** `shellcheck` was not available when they were written; they were only syntax-checked with `bash -n` and exercised against stub `launchctl`/`systemctl`. The Windows script has not been run anywhere.
