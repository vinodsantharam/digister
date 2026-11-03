import { describe, expect, it } from "vitest";
import {
  captureTimelines, graphqlOperation, shouldStop, targetsFor,
  type CaptureDeps, type CapturePage, type CaptureResponse, type LoopState,
} from "../src/sources/x/capture.js";
import type { ParsedPost } from "../src/sources/x/parse.js";

const NOW = Date.parse("2026-11-03T06:00:00Z");
const x = { graphql_operations: ["ListLatestTweetsTimeline"], lookback_hours: 30, max_posts_per_run: 300 };

const post = (id: string, iso: string, source: string | null = null): ParsedPost => ({
  id, author_handle: "a", author_name: "A", text: id, url: `https://x.com/a/status/${id}`, created_at: iso, source,
});
const resp = (op: string, body: unknown, status = 200): CaptureResponse => ({
  url: () => `https://x.com/i/api/graphql/QID123/${op}?variables=%7B%7D`,
  status: () => status,
  json: async () => body,
});

/** Fake page: each wheel() call emits the next scripted batch of responses. */
function fakePage(opts: { onGoto?: CaptureResponse[]; batches: CaptureResponse[][]; url?: string; html?: string }) {
  let cb: ((r: CaptureResponse) => void) | undefined;
  let i = 0;
  const calls = { wheel: [] as number[], closed: false };
  const page: CapturePage = {
    on: (_e, f) => { cb = f; },
    off: () => { cb = undefined; },
    goto: async () => { opts.onGoto?.forEach((r) => cb?.(r)); return { status: 200 }; },
    url: () => opts.url ?? "https://x.com/i/lists/1",
    html: async () => opts.html ?? "<html></html>",
    wheel: async (dy) => { calls.wheel.push(dy); (opts.batches[i++] ?? []).forEach((r) => cb?.(r)); },
    selectFollowing: async () => {},
    close: async () => { calls.closed = true; },
  };
  return { page, calls };
}

function deps(over: Partial<CaptureDeps> = {}) {
  let t = NOW;
  const raw: [string, number][] = [];
  const warns: object[] = [];
  const d: CaptureDeps = {
    now: () => t,
    random: () => 0.5,
    sleep: async (ms) => { t += ms; },
    saveRaw: (op, n) => { raw.push([op, n]); },
    loggedIn: async () => true,
    // body is {posts: ParsedPost[]}
    parse: (j) => (j as { posts: ParsedPost[] }).posts,
    log: { info: () => {}, warn: (o) => { warns.push(o); } },
    capMs: 4 * 60_000,
    ...over,
  };
  return { d, raw, warns };
}

const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

describe("graphqlOperation", () => {
  it("reads the segment after the query id", () => {
    expect(graphqlOperation("https://x.com/i/api/graphql/abc/ListLatestTweetsTimeline?v=1")).toBe("ListLatestTweetsTimeline");
    expect(graphqlOperation("https://x.com/home")).toBeUndefined();
    expect(graphqlOperation("not a url")).toBeUndefined();
  });
});

describe("shouldStop", () => {
  const base: LoopState = { oldestMs: null, cutoffMs: 100, postCount: 0, maxPosts: 10, scrolls: 0, emptyStreak: 0, elapsedMs: 0, capMs: 1000 };
  it("covers each condition", () => {
    expect(shouldStop(base)).toBeNull();
    expect(shouldStop({ ...base, oldestMs: 99 })).toBe("lookback");
    expect(shouldStop({ ...base, postCount: 10 })).toBe("max_posts");
    expect(shouldStop({ ...base, scrolls: 40 })).toBe("max_scrolls");
    expect(shouldStop({ ...base, emptyStreak: 3 })).toBe("no_new_posts");
    expect(shouldStop({ ...base, elapsedMs: 1000 })).toBe("time_cap");
  });
});

describe("captureTimelines", () => {
  const run = (page: CapturePage, d: CaptureDeps, targets = targetsFor({ list_urls: ["https://x.com/i/lists/1"], include_following: false })) =>
    captureTimelines(targets, async () => page, x, d);

  it("stops at the lookback boundary, filters responses and saves raw payloads", async () => {
    const { page, calls } = fakePage({
      onGoto: [resp("ListLatestTweetsTimeline", { posts: [post("1", hoursAgo(2))] }), resp("Other", { posts: [post("x", hoursAgo(1))] }), resp("ListLatestTweetsTimeline", { posts: [post("bad", hoursAgo(1))] }, 429)],
      batches: [
        [resp("ListLatestTweetsTimeline", { posts: [post("2", hoursAgo(10))] })],
        [resp("ListLatestTweetsTimeline", { posts: [post("3", hoursAgo(40))] })],
        [resp("ListLatestTweetsTimeline", { posts: [post("4", hoursAgo(50))] })],
      ],
    });
    const { d, raw } = deps();
    const r = await run(page, d);
    expect(r.status).toBe("ok");
    expect(r.posts.map((p) => p.id)).toEqual(["1", "2", "3"]);
    expect(r.stops).toEqual(["lookback"]);
    expect(calls.wheel).toHaveLength(2);
    expect(calls.wheel.every((n) => n >= 600 && n <= 1200)).toBe(true);
    expect(calls.closed).toBe(true);
    expect(raw).toEqual([["ListLatestTweetsTimeline", 1], ["ListLatestTweetsTimeline", 2], ["ListLatestTweetsTimeline", 3]]);
    expect(r.operationsSeen).toEqual(["ListLatestTweetsTimeline", "Other"]);
  });

  it("ignores old reposted tweets when judging the lookback", async () => {
    const { page } = fakePage({
      onGoto: [resp("ListLatestTweetsTimeline", { posts: [post("1", hoursAgo(1)), post("old", hoursAgo(500), "repost by @b")] })],
      batches: [[resp("ListLatestTweetsTimeline", { posts: [post("2", hoursAgo(2))] })]],
    });
    const r = await run(page, deps().d);
    expect(r.stops).toEqual(["no_new_posts"]);
    expect(r.posts.map((p) => p.id)).toContain("2");
  });

  it("ignores pinned posts when judging the lookback", async () => {
    const pinned = { ...post("pin", hoursAgo(20000)), pinned: true };
    const { page } = fakePage({
      onGoto: [resp("ListLatestTweetsTimeline", { posts: [pinned, post("1", hoursAgo(1))] })],
      batches: [[resp("ListLatestTweetsTimeline", { posts: [post("2", hoursAgo(2))] })]],
    });
    const r = await run(page, deps().d);
    expect(r.stops).toEqual(["no_new_posts"]);
    expect(r.posts.map((p) => p.id)).toContain("2");
  });

  it("stops after 3 scrolls with no new posts", async () => {
    const same = resp("ListLatestTweetsTimeline", { posts: [post("1", hoursAgo(1))] });
    const { page, calls } = fakePage({ onGoto: [same], batches: [] });
    const r = await run(page, deps().d);
    expect(r.stops).toEqual(["no_new_posts"]);
    expect(calls.wheel).toHaveLength(3);
  });

  it("stops at max posts", async () => {
    const mk = (n: number) => resp("ListLatestTweetsTimeline", { posts: Array.from({ length: 5 }, (_, i) => post(`${n}-${i}`, hoursAgo(1))) });
    const { page } = fakePage({ onGoto: [mk(0)], batches: [[mk(1)], [mk(2)]] });
    const { d } = deps();
    const r = await captureTimelines([{ url: "u" }], async () => page, { ...x, max_posts_per_run: 10 }, d);
    expect(r.stops).toEqual(["max_posts"]);
    expect(r.posts).toHaveLength(10);
  });

  it("stops after 40 scrolls", async () => {
    const batches = Array.from({ length: 60 }, (_, i) => [resp("ListLatestTweetsTimeline", { posts: [post(`p${i}`, hoursAgo(1))] })]);
    const { page, calls } = fakePage({ batches });
    const r = await run(page, deps().d);
    expect(r.stops).toEqual(["max_scrolls"]);
    expect(calls.wheel).toHaveLength(40);
  });

  it("stops at the time cap", async () => {
    const batches = Array.from({ length: 60 }, (_, i) => [resp("ListLatestTweetsTimeline", { posts: [post(`p${i}`, hoursAgo(1))] })]);
    const { page, calls } = fakePage({ batches });
    const r = await run(page, deps({ capMs: 10_000 }).d);
    expect(r.stops).toEqual(["time_cap"]);
    expect(calls.wheel.length).toBeLessThan(10);
  });

  it("reports needs_login on a login redirect, and when the cookie is missing", async () => {
    const a = fakePage({ batches: [], url: "https://x.com/i/flow/login" });
    expect((await run(a.page, deps().d)).status).toBe("needs_login");
    expect(a.calls.wheel).toHaveLength(0);
    const b = fakePage({ batches: [] });
    expect((await run(b.page, deps({ loggedIn: async () => false }).d)).status).toBe("needs_login");
  });

  it("logs the operation names seen when none matched", async () => {
    const { page } = fakePage({ onGoto: [resp("HomeTimeline", { posts: [] }), resp("UserByScreenName", {})], batches: [] });
    const { d, warns } = deps();
    const r = await run(page, d);
    expect(r.matchedResponses).toBe(0);
    expect(warns).toContainEqual(expect.objectContaining({ seen: ["HomeTimeline", "UserByScreenName"] }));
  });

  it("visits list pages then Following, one after another", async () => {
    const order: string[] = [];
    let active = 0;
    const targets = targetsFor({ list_urls: ["https://x.com/i/lists/1", "https://x.com/i/lists/2"], include_following: true });
    expect(targets.map((t) => t.following ?? false)).toEqual([false, false, true]);
    const r = await captureTimelines(targets, async () => {
      expect(active).toBe(0);
      active++;
      const { page } = fakePage({ batches: [] });
      return { ...page, goto: async (u: string) => { order.push(u); return { status: 200 }; }, close: async () => { active--; } };
    }, x, deps().d);
    expect(order).toEqual(["https://x.com/i/lists/1", "https://x.com/i/lists/2", "https://x.com/home"]);
    expect(r.status).toBe("ok");
  });
});
