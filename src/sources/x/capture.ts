import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import type { DigisterConfig } from "../../config.js";
import { getLogger } from "../../log.js";
import { getPaths } from "../../paths.js";
import { detectXState, hasAuthCookie, openXContext } from "./browser.js";
import { parseTimeline, type ParsedPost } from "./parse.js";

export type XConfig = DigisterConfig["x"];

export const FOLLOWING_URL = "https://x.com/home";
export const RUN_CAP_MS = 4 * 60_000;
export const MAX_SCROLLS = 40;
export const MAX_EMPTY_SCROLLS = 3;

/** The slice of a Playwright response that capture uses. */
export interface CaptureResponse {
  url(): string;
  status(): number;
  json(): Promise<unknown>;
}

/** The slice of a Playwright page that capture uses; tests provide a fake. */
export interface CapturePage {
  on(event: "response", cb: (r: CaptureResponse) => void): void;
  off(event: "response", cb: (r: CaptureResponse) => void): void;
  goto(url: string): Promise<{ status: number } | null>;
  url(): string;
  html(): Promise<string>;
  wheel(dy: number): Promise<void>;
  /** Select the "Following" tab on the home timeline. */
  selectFollowing(): Promise<void>;
  close?(): Promise<void>;
}

export type StopReason = "lookback" | "max_posts" | "max_scrolls" | "no_new_posts" | "time_cap";

export interface LoopState {
  oldestMs: number | null;
  cutoffMs: number;
  postCount: number;
  maxPosts: number;
  scrolls: number;
  emptyStreak: number;
  elapsedMs: number;
  capMs: number;
}

/** Pure: should the scroll loop stop now, and why. */
export function shouldStop(s: LoopState): StopReason | null {
  if (s.elapsedMs >= s.capMs) return "time_cap";
  if (s.oldestMs !== null && s.oldestMs < s.cutoffMs) return "lookback";
  if (s.postCount >= s.maxPosts) return "max_posts";
  if (s.scrolls >= MAX_SCROLLS) return "max_scrolls";
  if (s.emptyStreak >= MAX_EMPTY_SCROLLS) return "no_new_posts";
  return null;
}

/** `/i/api/graphql/<queryId>/<OperationName>` -> OperationName, or undefined. */
export function graphqlOperation(url: string): string | undefined {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return undefined;
  }
  const parts = pathname.split("/").filter(Boolean);
  const i = parts.indexOf("graphql");
  if (i < 0) return undefined;
  return parts[i + 2] ?? parts[parts.length - 1];
}

export type CaptureStatus = "ok" | "needs_login";

export interface CaptureResult {
  status: CaptureStatus;
  posts: ParsedPost[];
  /** Why each page stopped scrolling, in order. */
  stops: StopReason[];
  /** Every GraphQL operation name seen, matched or not. */
  operationsSeen: string[];
  matchedResponses: number;
}

export interface CaptureDeps {
  now: () => number;
  random: () => number;
  sleep: (ms: number) => Promise<void>;
  saveRaw: (operation: string, n: number, body: unknown) => void;
  /** Whether the auth_token cookie exists. */
  loggedIn: () => Promise<boolean>;
  parse: (json: unknown) => ParsedPost[];
  log: { info: (o: object, msg: string) => void; warn: (o: object, msg: string) => void };
  capMs: number;
}

export interface Target {
  url: string;
  following?: boolean;
}

export function targetsFor(x: Pick<XConfig, "list_urls" | "include_following">): Target[] {
  const t: Target[] = x.list_urls.map((url) => ({ url }));
  if (x.include_following) t.push({ url: FOLLOWING_URL, following: true });
  return t;
}

/**
 * Drive pages one at a time, collecting parsed posts from matching GraphQL responses.
 * `pages` yields a fresh page per target (the caller closes it).
 */
export async function captureTimelines(
  targets: Target[],
  newPage: () => Promise<CapturePage>,
  x: Pick<XConfig, "graphql_operations" | "lookback_hours" | "max_posts_per_run">,
  deps: CaptureDeps,
): Promise<CaptureResult> {
  const started = deps.now();
  const cutoffMs = started - x.lookback_hours * 3_600_000;
  const posts = new Map<string, ParsedPost>();
  const seen = new Set<string>();
  const counters = new Map<string, number>();
  const stops: StopReason[] = [];
  let matched = 0;
  let oldestMs: number | null = null;
  let status: CaptureStatus = "ok";

  const pause = () => deps.sleep(1500 + deps.random() * 2500);

  for (const target of targets) {
    if (deps.now() - started >= deps.capMs) {
      stops.push("time_cap");
      break;
    }
    const page = await newPage();
    const pending: Promise<void>[] = [];
    const onResponse = (r: CaptureResponse) => {
      const op = graphqlOperation(r.url());
      if (!r.url().includes("/graphql/") || !op) return;
      seen.add(op);
      if (!x.graphql_operations.includes(op) || r.status() !== 200) return;
      pending.push(
        (async () => {
          try {
            const body = await r.json();
            matched++;
            const n = (counters.get(op) ?? 0) + 1;
            counters.set(op, n);
            deps.saveRaw(op, n, body);
            for (const p of deps.parse(body)) {
              if (!posts.has(p.id)) posts.set(p.id, p);
              // Reposts embed old tweets; only the posts themselves tell us how far back we are.
              if (p.source === null) {
                const t = Date.parse(p.created_at);
                if (!Number.isNaN(t) && (oldestMs === null || t < oldestMs)) oldestMs = t;
              }
            }
          } catch (err) {
            deps.log.warn({ op, err: (err as Error).message }, "x response could not be read");
          }
        })(),
      );
    };
    const drain = async () => {
      await Promise.all(pending.splice(0));
    };

    page.on("response", onResponse);
    try {
      const response = await page.goto(target.url);
      await pause();
      const state = detectXState({
        url: page.url(),
        status: response?.status ?? null,
        html: (await page.html()).slice(0, 200_000),
        hasAuthCookie: await deps.loggedIn(),
      });
      if (state !== "logged_in") {
        deps.log.warn({ state, url: page.url() }, "x needs login; skipping X");
        status = "needs_login";
        break;
      }
      if (target.following) {
        await page.selectFollowing();
        await pause();
      }
      await drain();

      let scrolls = 0;
      let emptyStreak = 0;
      for (;;) {
        const stop = shouldStop({
          oldestMs,
          cutoffMs,
          postCount: posts.size,
          maxPosts: x.max_posts_per_run,
          scrolls,
          emptyStreak,
          elapsedMs: deps.now() - started,
          capMs: deps.capMs,
        });
        if (stop) {
          stops.push(stop);
          break;
        }
        const before = posts.size;
        await page.wheel(600 + Math.floor(deps.random() * 601));
        await pause();
        await drain();
        scrolls++;
        emptyStreak = posts.size > before ? 0 : emptyStreak + 1;
      }
    } finally {
      page.off("response", onResponse);
      await page.close?.().catch(() => undefined);
    }
  }

  if (matched === 0 && status === "ok") {
    deps.log.warn(
      { configured: x.graphql_operations, seen: [...seen].sort() },
      "no configured GraphQL operation matched; update x.graphql_operations in digister.yaml",
    );
  }

  const all = [...posts.values()].slice(0, x.max_posts_per_run);
  return { status, posts: all, stops, operationsSeen: [...seen].sort(), matchedResponses: matched };
}

function wrapPage(page: Page): CapturePage {
  return {
    on: (e, cb) => void page.on(e, cb),
    off: (e, cb) => void page.off(e, cb),
    goto: async (url) => {
      const r = await page.goto(url, { timeout: 45_000, waitUntil: "domcontentloaded" });
      return r ? { status: r.status() } : null;
    },
    url: () => page.url(),
    html: () => page.content(),
    wheel: async (dy) => {
      await page.mouse.wheel(0, dy);
    },
    selectFollowing: async () => {
      await page.getByRole("tab", { name: "Following" }).click({ timeout: 10_000 });
    },
    close: () => page.close(),
  };
}

/** Real entry point: one headless/headed session, one page per target, sequential. */
export async function captureX(x: XConfig, overrides: Partial<CaptureDeps> = {}): Promise<CaptureResult> {
  const context = await openXContext({ headless: x.headless });
  const rawDir = path.join(getPaths().raw, "x", new Date().toISOString().slice(0, 10));
  const deps: CaptureDeps = {
    now: Date.now,
    random: Math.random,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    saveRaw: (op, n, body) => {
      mkdirSync(rawDir, { recursive: true });
      writeFileSync(path.join(rawDir, `${op}-${n}.json`), JSON.stringify(body));
    },
    loggedIn: () => hasAuthCookie(context),
    parse: parseTimeline,
    log: getLogger(),
    capMs: RUN_CAP_MS,
    ...overrides,
  };
  try {
    return await captureTimelines(
      targetsFor(x),
      async () => {
        const open = context.pages().filter((p) => !p.isClosed());
        const page = open.length === 1 && open[0]!.url() === "about:blank" ? open[0]! : await context.newPage();
        return wrapPage(page);
      },
      x,
      deps,
    );
  } finally {
    await context.close();
  }
}
