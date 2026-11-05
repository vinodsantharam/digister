import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseTimeline, xDateToIso } from "../src/sources/x/parse.js";

const load = (n: string) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), "utf8"));
const byId = (posts: ReturnType<typeof parseTimeline>) => Object.fromEntries(posts.map((p) => [p.id, p]));

describe("xDateToIso", () => {
  it("converts X dates", () => {
    expect(xDateToIso("Wed Oct 30 05:30:00 +0000 2026")).toBe("2026-10-30T05:30:00.000Z");
    expect(xDateToIso("garbage")).toBeUndefined();
  });
});

describe("parseTimeline (list)", () => {
  const posts = parseTimeline(load("x-list-timeline.json"));
  const p = byId(posts);

  it("parses a plain tweet", () => {
    expect(p["1001"]).toMatchObject({
      author_handle: "alice", author_name: "Alice", url: "https://x.com/alice/status/1001",
      created_at: "2026-11-03T05:30:00.000Z", lang: "en", like_count: 42, repost_count: 5, source: null,
    });
    expect(JSON.parse(p["1001"]!.links_json!)).toEqual(["https://ollama.com/blog/new"]);
  });
  it("prefers the long note tweet text", () => {
    expect(p["1002"]!.text.length).toBeGreaterThan(400);
    expect(p["1002"]!.text).toContain("Quantization");
  });
  it("replaces a retweet with the inner tweet and records the reposter", () => {
    expect(p["1003"]).toBeUndefined();
    expect(p["1000"]).toMatchObject({ author_handle: "alice", source: "repost by @carol" });
  });
  it("parses quotes as their own post and sets quoted_id", () => {
    expect(p["1004"]!.quoted_id).toBe("0999");
    expect(p["0999"]!.author_handle).toBe("erin");
  });
  it("keeps reply info for self-replies and other replies", () => {
    expect(p["1006"]).toMatchObject({ reply_to_id: "1005", conversation_id: "1005", author_handle: "alice" });
    expect(p["1007"]!.reply_to_id).toBe("1005");
  });
  it("unwraps TweetWithVisibilityResults and reads media", () => {
    expect(p["1008"]!.author_handle).toBe("gina");
    expect(JSON.parse(p["1008"]!.media_json!)).toEqual([{ type: "photo", url: "https://pbs.twimg.com/media/x.jpg" }]);
  });
  it("supports the older legacy.screen_name author location", () => {
    expect(p["1009"]).toMatchObject({ author_handle: "henry", author_name: "Henry" });
  });
  it("skips promoted entries and has no duplicates", () => {
    expect(p["5550001"]).toBeUndefined();
    expect(new Set(posts.map((x) => x.id)).size).toBe(posts.length);
  });
});

describe("parseTimeline (following)", () => {
  const posts = parseTimeline(load("x-following-timeline.json"));
  const p = byId(posts);
  it("finds tweets in modules and skips promotedMetadata on the tweet", () => {
    expect(p["2003"]).toBeDefined();
    expect(p["2004"]!.reply_to_id).toBe("2003");
    expect(p["5550002"]).toBeUndefined();
  });
  it("handles note tweets and reposts", () => {
    expect(p["2001"]!.text).toContain("(note)");
    expect(p["2000"]!.source).toBe("repost by @jack");
  });
});

describe("parseTimeline robustness", () => {
  it("returns [] for junk and does not depend on the envelope path", () => {
    expect(parseTimeline(null)).toEqual([]);
    expect(parseTimeline({ a: [1, "x", { b: {} }] })).toEqual([]);
    const inner = load("x-following-timeline.json").data.home;
    expect(parseTimeline({ whatever: { nested: [inner] } }).length).toBeGreaterThan(0);
  });
});

describe("parseTimeline (pinned)", () => {
  const tweet = (id: string, created: string) => ({
    __typename: "Tweet", rest_id: id,
    core: { user_results: { result: { core: { screen_name: "alice", name: "Alice" } } } },
    legacy: { full_text: id, created_at: created },
  });
  const payload = {
    instructions: [
      { type: "TimelinePinEntry", entry: { entryId: "tweet-1", content: { itemContent: { tweet_results: { result: tweet("1", "Mon Jan 01 00:00:00 +0000 2018") } } } } },
      { type: "TimelineAddEntries", entries: [{ entryId: "tweet-2", content: { itemContent: { tweet_results: { result: tweet("2", "Mon Nov 02 00:00:00 +0000 2026") } } } }] },
    ],
  };

  it("flags tweets inside a TimelinePinEntry", () => {
    const p = byId(parseTimeline(payload));
    expect(p["1"]!.pinned).toBe(true);
    expect(p["2"]!.pinned).toBeUndefined();
  });
});
