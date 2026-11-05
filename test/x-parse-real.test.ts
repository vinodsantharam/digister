import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseTimeline } from "../src/sources/x/parse.js";

// Recorded X GraphQL responses from twscrape (MIT); see test/fixtures/real/SOURCE.md.
const load = (n: string) => JSON.parse(readFileSync(new URL(`./fixtures/real/${n}`, import.meta.url), "utf8"));
const byId = (posts: ReturnType<typeof parseTimeline>) => Object.fromEntries(posts.map((p) => [p.id, p]));

describe("parseTimeline on a real ListLatestTweetsTimeline response", () => {
  const posts = parseTimeline(load("twscrape-list-latest-tweets-timeline.json"));
  const p = byId(posts);

  it("parses every post with sane core fields and no duplicates", () => {
    expect(posts.length).toBeGreaterThanOrEqual(45);
    expect(new Set(posts.map((x) => x.id)).size).toBe(posts.length);
    for (const x of posts) {
      expect(x.id).toMatch(/^\d{15,}$/);
      expect(x.author_handle).toMatch(/^\w{1,15}$/);
      expect(x.url).toBe(`https://x.com/${x.author_handle}/status/${x.id}`);
      expect(new Date(x.created_at).toISOString()).toBe(x.created_at);
    }
  });
  it("reads a plain tweet", () => {
    expect(p["2085472697924890822"]).toMatchObject({
      author_handle: "PolymarketIntel", source: null, created_at: "2026-08-06T21:06:52.000Z",
    });
  });
  it("replaces a retweet with the original and records the reposter", () => {
    expect(p["2085464146892447815"]).toMatchObject({ author_handle: "atrupar", source: "repost by @IlvesToomas" });
    expect(posts.some((x) => x.text.startsWith("RT @"))).toBe(false);
  });
  it("keeps quote ids and includes the quoted post", () => {
    expect(p["2085429472375763298"]!.quoted_id).toBe("2085427036605047137");
    expect(p["2085427036605047137"]!.author_handle).toBe("jurgen_nauditt");
  });
  it("reads self-thread modules and reply info", () => {
    expect(p["2085455974131740934"]).toMatchObject({ reply_to_id: "2085455971833327974", author_handle: "KyivIndependent" });
  });
  it("uses the full note tweet text", () => {
    expect(posts.filter((x) => x.text.length > 280).length).toBeGreaterThan(5);
  });
  it("expands t.co links and drops media/quote placeholders", () => {
    expect(posts.some((x) => /https:\/\/t\.co\//.test(x.text))).toBe(false);
    expect(p["2085462156196094058"]!.text).toContain("https://www.spiegel.de/");
    expect(p["2085464146892447815"]!.text.endsWith("We're separated by an ocean.")).toBe(true);
    expect(JSON.parse(p["2085464146892447815"]!.media_json!)[0].type).toBe("video");
  });
  it("contains no promoted posts and no pinned posts", () => {
    expect(posts.some((x) => x.pinned)).toBe(false);
  });
});

describe("parseTimeline on a real UserTweets response", () => {
  const posts = parseTimeline(load("twscrape-user-tweets.json"));
  const p = byId(posts);

  it("marks the pinned tweet", () => {
    expect(p["2019881223666233717"]).toMatchObject({ author_handle: "XDevelopers", pinned: true });
    expect(posts.filter((x) => x.pinned)).toHaveLength(1);
  });
  it("decodes HTML entities in legacy text", () => {
    expect(p["2082640274845811115"]!.text).toContain("X Chat API & Chat XDK");
    expect(posts.some((x) => /&(amp|lt|gt|quot);/.test(x.text))).toBe(false);
  });
  it("parses a repost of a quote tweet", () => {
    expect(p["2082642493892628916"]).toMatchObject({ source: "repost by @XDevelopers", quoted_id: "2082640274845811115" });
  });
  it("replaces article-only text links with the real address", () => {
    expect(p["2079756440722665849"]!.text).toBe("http://x.com/i/article/2079162061142335488");
  });
});
