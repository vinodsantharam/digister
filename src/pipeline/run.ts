import { spawn } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  ConfigError, loadChannels, loadDigisterConfig, loadInterests,
  type ChannelsConfig, type DigisterConfig, type InterestsConfig,
} from "../config.js";
import { getLogger } from "../log.js";
import { ollamaHealthy, type OllamaStatus, type StructuredDeps } from "../llm/client.js";
import { getPaths } from "../paths.js";
import { digestSubject, sendDigestEmail, type MailTransport } from "../deliver/email.js";
import { renderDigest, renderDigestText, type DigestData } from "../render/Digest.js";
import { writeDigest } from "../render/write.js";
import { collectVideos } from "../sources/youtube/rss.js";
import { enrichVideos } from "../sources/youtube/enrich.js";
import type { FetchFn } from "../sources/youtube/channels.js";
import { captureX, type CaptureResult } from "../sources/x/capture.js";
import {
  finishRun, markShown, openDb, selectablePosts, selectableVideos, startRun, unscoredPosts, unscoredVideos,
  upsertPost, type Db,
} from "../store/db.js";
import { isMuted } from "./common.js";
import { scorePosts } from "./score-posts.js";
import { scoreVideos } from "./score-videos.js";
import { buildBrief, type DigestBrief } from "./brief.js";
import { selectBriefPosts, selectPosts, selectVideos } from "./select.js";

export interface RunOptions {
  /** Read YouTube only; no LLM calls, no X, no writes except logs. */
  dry?: boolean;
}

/** Everything that touches the outside world, replaceable in tests. */
export interface RunDeps {
  fetchFn?: FetchFn;
  captureX?: (x: DigisterConfig["x"]) => Promise<CaptureResult>;
  llm?: StructuredDeps;
  health?: () => Promise<OllamaStatus>;
  /** Start `ollama serve` and wait for it to come up. */
  startOllama?: () => Promise<void>;
  now?: () => Date;
  out?: (line: string) => void;
  /** SMTP transport for the email step; defaults to nodemailer with the configured server. */
  mailTransport?: MailTransport;
}

/** Keep the brief's model output next to the raw X payloads, for debugging. Never fails the run. */
function saveBrief(brief: DigestBrief, date: string): void {
  try {
    const slim = {
      headlines: brief.headlines,
      stories: brief.stories.map((s) => ({ ...s, sources: s.sources.map((p) => p.id) })),
      quick_hits: brief.quickHits.map((q) => ({ line: q.line, post: q.post.id })),
      leftovers: brief.leftovers.map((p) => p.id),
    };
    writeFileSync(path.join(getPaths().raw, `brief-${date}.json`), JSON.stringify(slim, null, 2));
  } catch (err) {
    getLogger().warn({ err: (err as Error).message }, "could not save brief json");
  }
}

export interface RunOutcome {
  exitCode: 0 | 1;
  digestPath?: string;
  warnings: string[];
}

export const LOCK_NAME = "run.lock";
const LOCK_STALE_MS = 6 * 3_600_000;

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** Take DIGISTER_HOME/run.lock (exclusive create). Returns a release function. A lock whose process is gone, or older than 6 hours, is stale and replaced. */
export function acquireLock(home: string, nowMs: number = Date.now()): () => void {
  const file = path.join(home, LOCK_NAME);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(file, JSON.stringify({ pid: process.pid, started: new Date(nowMs).toISOString() }), { flag: "wx" });
      return () => rmSync(file, { force: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      let holder: { pid?: number; started?: string } = {};
      try {
        holder = JSON.parse(readFileSync(file, "utf8"));
      } catch {
        /* unreadable lock: treat as stale */
      }
      const age = nowMs - Date.parse(holder.started ?? "");
      const live = typeof holder.pid === "number" && pidAlive(holder.pid) && !(age > LOCK_STALE_MS);
      if (live) throw new Error(`another digister run is in progress (pid ${holder.pid}); lock file ${file}`);
      rmSync(file, { force: true });
    }
  }
  throw new Error(`could not take the lock ${file}`);
}

async function defaultStartOllama(): Promise<void> {
  const child = spawn("ollama", ["serve"], { detached: true, stdio: "ignore" });
  child.on("error", () => undefined);
  child.unref();
  await new Promise((r) => setTimeout(r, 10_000));
}

/** Reachable and model pulled, starting `ollama serve` once if it is not reachable. */
async function ensureOllama(deps: RunDeps): Promise<OllamaStatus> {
  const health = deps.health ?? (() => ollamaHealthy());
  let s = await health();
  if (!s.reachable) {
    getLogger().info("ollama not reachable; trying `ollama serve`");
    await (deps.startOllama ?? defaultStartOllama)();
    s = await health();
  }
  return s;
}

const hoursAgoIso = (now: Date, h: number) => new Date(now.getTime() - h * 3_600_000).toISOString();

function loadAll(): { cfg: DigisterConfig; channels: ChannelsConfig; interests: InterestsConfig } {
  return { cfg: loadDigisterConfig(), channels: loadChannels(), interests: loadInterests() };
}

/** `digister run --dry`: YouTube RSS into a throwaway in-memory db, then print counts. */
async function dryRun(deps: RunDeps): Promise<RunOutcome> {
  const out = deps.out ?? console.log;
  const now = deps.now?.() ?? new Date();
  const { cfg, channels, interests } = loadAll();
  const db = openDb(":memory:");
  const { videos, failed } = await collectVideos(db, channels.channels, {
    lookbackHours: cfg.youtube.lookback_hours, fetchFn: deps.fetchFn, now,
  });
  const mustIds = new Set(channels.channels.filter((c) => c.tier === "must").map((c) => c.id));
  const found = unscoredVideos(db, hoursAgoIso(now, cfg.youtube.lookback_hours));
  const muted = found.filter((v) => isMuted(`${v.title}\n${v.description}`, interests.mute));
  const mutedIds = new Set(muted.map((v) => v.id));
  const shorts = found.filter((v) => !mutedIds.has(v.id) && v.is_short === 1 && !mustIds.has(v.channel_id));
  const wouldScore = found.length - muted.length - shorts.length;
  const warnings = failed.length ? [`YouTube feeds failed for: ${failed.join(", ")}`] : [];
  out(`Dry run (no LLM calls, no X, nothing written except logs)`);
  out(`YouTube: ${channels.channels.length} channels, ${failed.length} feeds failed, ${videos} videos in the last ${cfg.youtube.lookback_hours} h`);
  out(`Would score ${wouldScore} videos in ${Math.ceil(wouldScore / 10)} batches (${muted.length} muted, ${shorts.length} Shorts skipped)`);
  const xTargets = cfg.x.list_urls.length + (cfg.x.include_following ? 1 : 0);
  out(cfg.x.enabled ? `X: would open ${xTargets} page(s) and scroll back ${cfg.x.lookback_hours} h (skipped in dry run)` : "X: disabled");
  out(`Would write digest to ${cfg.output_dir}`);
  for (const w of warnings) out(`WARNING: ${w}`);
  return { exitCode: 0, warnings };
}

/** The daily pipeline. Resolves with an exit code instead of throwing. */
export async function runPipeline(opts: RunOptions = {}, deps: RunDeps = {}): Promise<RunOutcome> {
  const out = deps.out ?? console.log;
  const log = getLogger();
  const fail = (message: string): RunOutcome => {
    out(`ERROR: ${message}`);
    return { exitCode: 1, warnings: [] };
  };

  if (opts.dry) {
    try {
      return await dryRun(deps);
    } catch (err) {
      return fail((err as Error).message);
    }
  }

  const paths = getPaths();
  let release: () => void;
  try {
    release = acquireLock(paths.home);
  } catch (err) {
    return fail((err as Error).message);
  }
  try {
    return await execute(deps, out);
  } catch (err) {
    log.error({ err: (err as Error).message }, "run failed");
    return fail(err instanceof ConfigError ? err.message : (err as Error).message);
  } finally {
    release();
  }
}

async function execute(deps: RunDeps, out: (line: string) => void): Promise<RunOutcome> {
  const log = getLogger();
  const { cfg, channels, interests } = loadAll();

  const ollama = await ensureOllama(deps);
  if (!ollama.ok) {
    out(`ERROR: Ollama is not ready: ${ollama.error ?? "unknown problem"}. Start Ollama (ollama serve) and run: ollama pull ${ollama.model}`);
    return { exitCode: 1, warnings: [] };
  }

  const db = openDb();
  const runId = startRun(db);
  const now = deps.now?.() ?? new Date();
  const date = now.toISOString().slice(0, 10);
  const warnings: string[] = [];
  let videosSeen = 0;
  let xPostsSeen = 0;
  let filtered = 0;

  try {
    // YouTube
    try {
      const r = await collectVideos(db, channels.channels, {
        lookbackHours: cfg.youtube.lookback_hours, fetchFn: deps.fetchFn, now,
      });
      videosSeen = r.videos;
      if (r.failed.length) warnings.push(`YouTube feeds failed for: ${r.failed.join(", ")}`);
      if (cfg.youtube.data_api_key) await enrichVideos(db, { apiKey: cfg.youtube.data_api_key, fetchFn: deps.fetchFn });
    } catch (err) {
      log.error({ err: (err as Error).message }, "youtube collection failed");
      warnings.push(`YouTube failed: ${(err as Error).message}`);
    }

    // X
    const hasTargets = cfg.x.list_urls.length > 0 || cfg.x.include_following;
    if (!cfg.x.enabled) warnings.push("X is disabled in digister.yaml; this digest has no X posts");
    else if (!hasTargets) warnings.push("X has no list_urls and include_following is off; this digest has no X posts");
    else {
      try {
        const cap = await (deps.captureX ?? ((x) => captureX(x)))(cfg.x);
        for (const { pinned: _pinned, ...post } of cap.posts) upsertPost(db, post);
        xPostsSeen = cap.posts.length;
        if (cap.status === "needs_login") warnings.push("X needs login: run `digister x login`");
        else if (cap.matchedResponses === 0)
          warnings.push(
            `X returned no timeline data; the GraphQL operation names may have changed (seen: ${cap.operationsSeen.join(", ") || "none"}). Update x.graphql_operations in digister.yaml`,
          );
      } catch (err) {
        log.error({ err: (err as Error).message }, "x capture failed");
        warnings.push(`X failed: ${(err as Error).message}`);
      }
    }

    // Score
    const videoSince = hoursAgoIso(now, cfg.youtube.lookback_hours);
    const postSince = hoursAgoIso(now, cfg.x.lookback_hours);
    const vs = await scoreVideos(db, {
      interests, channels, sinceIso: videoSince, mustWatchMax: cfg.digest.must_watch_max, llm: deps.llm,
    });
    const ps = await scorePosts(db, { interests, sinceIso: postSince, llm: deps.llm });
    filtered = vs.muted + vs.shortsSkipped + ps.muted + ps.repliesDropped + ps.merged;
    if (vs.unscored) warnings.push(`${vs.unscored} videos could not be scored by the model`);
    if (ps.unscored) warnings.push(`${ps.unscored} posts could not be scored by the model`);

    // Select, brief, render, write
    const vsel = selectVideos(selectableVideos(db, videoSince), channels, cfg.digest);
    const candidates = selectablePosts(db, postSince);
    let brief: DigestBrief | null = null;
    if (cfg.digest.mode === "brief") {
      const briefPosts = selectBriefPosts(candidates, cfg.digest);
      if (briefPosts.length) {
        brief = await buildBrief(briefPosts, interests, deps.llm, {
          storiesMax: cfg.digest.brief_stories_max,
          quickHitsMax: cfg.digest.brief_quick_hits_max,
        });
        if (brief) saveBrief(brief, date);
        else warnings.push("The brief could not be written by the model; showing the post list instead");
      }
    }
    const psel = brief ? { groups: [], readingMinutes: 0 } : selectPosts(candidates, interests, cfg.digest);
    const data: DigestData = {
      date, generatedAt: now.toISOString(), warnings, mustWatch: vsel.mustWatch, alsoNew: vsel.alsoNew,
      groups: psel.groups, readingMinutes: psel.readingMinutes, filtered, brief,
    };
    const digestPath = writeDigest(renderDigest(data), cfg.output_dir, date);

    if (cfg.email.enabled) {
      try {
        await sendDigestEmail(
          {
            subject: digestSubject(date, brief?.headlines[0]),
            html: renderDigest(data, { variant: "email" }),
            text: renderDigestText(data),
          },
          cfg.email,
          { transport: deps.mailTransport },
        );
        out(`Digest emailed to ${cfg.email.to}`);
      } catch (err) {
        log.error({ err: (err as Error).message }, "email failed");
        warnings.push(`Email failed: ${(err as Error).message}`);
      }
    }

    const shownPosts = brief
      ? [...brief.stories.flatMap((s) => s.sources), ...brief.quickHits.map((q) => q.post), ...brief.leftovers]
      : psel.groups.flatMap((g) => g.posts);
    markShown(db, "video", [...vsel.mustWatch, ...vsel.alsoNew].map((v) => v.id), date);
    markShown(db, "post", shownPosts.map((p) => p.id), date);
    finishRun(db, runId, {
      status: warnings.length ? "ok_with_warnings" : "ok", x_posts_seen: xPostsSeen, videos_seen: videosSeen, digest_path: digestPath,
    });
    out(`Digest written: ${digestPath}`);
    for (const w of warnings) out(`WARNING: ${w}`);
    return { exitCode: 0, digestPath, warnings };
  } catch (err) {
    finishRun(db, runId, { status: "failed", x_posts_seen: xPostsSeen, videos_seen: videosSeen, error: (err as Error).message });
    throw err;
  } finally {
    db.close();
  }
}
