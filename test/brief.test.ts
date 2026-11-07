import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import type { InterestsConfig } from "../src/config.js";
import {
  buildBrief, clusterPrompt, importance, normalizeClusters, normalizeHeadlines, splitUnrelated, storyPrompt, topicOf, type Story,
} from "../src/pipeline/brief.js";
import { selectBriefPosts } from "../src/pipeline/select.js";
import type { Post } from "../src/store/db.js";
import { reply } from "./helpers.js";

const interests: InterestsConfig = {
  topics: [
    { name: "AI", weight: 1, description: "ai" },
    { name: "Tooling", weight: 1, description: "dev tools" },
  ],
  mute: [],
};

const post = (id: string, score: number, over: Partial<Post> = {}): Post => ({
  id, author_handle: `h${id}`, author_name: `N${id}`, text: `text ${id}`, url: `https://x.com/h${id}/status/${id}`,
  created_at: "2026-11-02T10:00:00Z", lang: "en", reply_to_id: null, quoted_id: null, conversation_id: null, like_count: 0,
  repost_count: 0, media_json: "[]", links_json: "[]", source: null, first_seen_at: "", score, topic: "AI",
  summary: `summary ${id}`, scored_at: "", shown_in: null, ...over,
});

const posts = [post("a", 9), post("b", 8), post("c", 7), post("d", 6)];

const ids = (ps: Post[]) => ps.map((p) => p.id);

describe("normalizeClusters", () => {
  it("covers every post exactly once: unknown and repeated ids dropped, singles dissolved, missing posts alone", () => {
    const c = normalizeClusters(
      { groups: [{ post_ids: ["d", "zzz", "b"] }, { post_ids: ["b", "c"] }, { post_ids: ["a"] }] },
      posts,
    );
    expect(c.map((x) => ids(x.posts))).toEqual([["a"], ["b", "d"], ["c"]]); // a: 9 beats b+d: 8 + 0.5
  });

  it("ranks by importance: best score plus a bonus for each extra author", () => {
    const same = [post("x", 6, { author_handle: "a" }), post("y", 6, { author_handle: "b" }), post("z", 6, { author_handle: "c" })];
    expect(importance(same)).toBe(7);
    expect(importance([post("x", 6), post("y", 6)].map((p) => ({ ...p, author_handle: "same" })))).toBe(6);
    const crowd = Array.from({ length: 9 }, (_, i) => post(`c${i}`, 5, { author_handle: `u${i}` }));
    expect(importance(crowd)).toBe(7);
    const c = normalizeClusters({ groups: [{ post_ids: ["x", "y", "z"] }] }, [post("solo", 6.5), ...same]);
    expect(ids(c[0]!.posts)).toEqual(["x", "y", "z"]);
  });
});

describe("splitUnrelated", () => {
  it("keeps only the posts the story pass used; an empty or unknown list keeps the group", () => {
    const r = splitUnrelated(posts, ["a", "c", "zzz"]);
    expect([ids(r.kept), ids(r.unrelated)]).toEqual([["a", "c"], ["b", "d"]]);
    expect(ids(splitUnrelated(posts, []).kept)).toEqual(["a", "b", "c", "d"]);
    expect(ids(splitUnrelated(posts, ["zzz"]).kept)).toEqual(["a", "b", "c", "d"]);
  });
});

describe("topicOf", () => {
  it("picks the topic most of the score sits in, and other for unknown topics", () => {
    expect(topicOf([post("a", 9, { topic: "Tooling" }), post("b", 5), post("c", 5)], interests)).toBe("AI");
    expect(topicOf([post("a", 9, { topic: "Made up" })], interests)).toBe("other");
  });
});

describe("normalizeHeadlines", () => {
  const story = (title: string): Story => ({ topic: "AI", title, body: "", sources: [] });
  it("keeps one line per known story in story order, and falls back to titles", () => {
    const stories = [story("One"), story("Two"), story("Three")];
    const h = normalizeHeadlines(
      { headlines: [{ story: "s3", line: " Third \n line " }, { story: "s1", line: "First" }, { story: "s1", line: "dup" }, { story: "s9", line: "ghost" }] },
      stories,
    );
    expect(h).toEqual(["First", "Two", "Third line"]);
    expect(normalizeHeadlines(null, stories)).toEqual(["One", "Two", "Three"]);
  });
});

describe("prompts", () => {
  it("cluster prompt is one short line per post; story prompt carries the full text up to 600 characters", () => {
    expect(clusterPrompt([post("a", 9)])).toContain("a | @ha | summary a");
    const p = storyPrompt([post("a", 9, { text: `line one\nline two ${"x".repeat(900)}` })]);
    expect(p).toContain("id a, @ha:\nline one line two");
    expect(p).not.toContain("x".repeat(601));
  });
});

const system = (opts: { prompt: unknown }) => JSON.stringify(opts.prompt);

/** A model that answers each pass by its system prompt. */
const passes = (answers: { cluster?: unknown; story?: (prompt: string) => unknown; headlines?: unknown }) =>
  new MockLanguageModelV4({
    doGenerate: async (opts) => {
      const text = system(opts);
      if (text.includes("You group posts")) return reply(answers.cluster ?? { groups: [] });
      if (text.includes("You write one story")) return reply(answers.story?.(text) ?? { nope: 1 });
      return reply(answers.headlines ?? { nope: 1 });
    },
  });

describe("buildBrief", () => {
  it("clusters, writes a story per group or strong single post, and turns the rest into quick hits", async () => {
    const all = [post("a", 9), post("b", 6, { author_handle: "other" }), post("c", 7), post("d", 5), post("e", 9.5)];
    const model = passes({
      cluster: { groups: [{ post_ids: ["a", "b"] }] },
      story: (t) => ({ title: t.includes("text e") ? "Solo" : "Pair", body: "Body." }),
      headlines: { headlines: [{ story: "s1", line: "Pair line" }] },
    });
    const b = await buildBrief(all, interests, { model });
    // 1 cluster call + 2 story calls (a+b, e) + 1 headlines call; c and d need no call.
    expect(model.doGenerateCalls).toHaveLength(4);
    expect(b?.stories.map((s) => [s.title, ids(s.sources)])).toEqual([["Pair", ["a", "b"]], ["Solo", ["e"]]]);
    expect(b?.headlines).toEqual(["Pair line", "Solo"]);
    expect(b?.quickHits.map((q) => [q.post.id, q.line])).toEqual([["c", "summary c"], ["d", "summary d"]]);
    expect(b?.leftovers).toEqual([]);
  });

  it("moves posts the story pass did not use out of the story, into quick hits", async () => {
    const model = passes({
      cluster: { groups: [{ about: "x", post_ids: ["a", "b", "c"] }] },
      story: () => ({ used_ids: ["a", "b"], title: "AB", body: "B" }),
    });
    const b = await buildBrief(posts, interests, { model });
    expect(b?.stories.map((s) => ids(s.sources))).toEqual([["a", "b"]]);
    expect(b?.quickHits.map((q) => q.post.id)).toEqual(["c", "d"]);
  });

  it("respects the story and quick-hit limits; the rest become counted leftovers", async () => {
    const model = passes({ cluster: { groups: [{ post_ids: ["a", "b"] }, { post_ids: ["c", "d"] }] }, story: () => ({ title: "T", body: "B" }) });
    const b = await buildBrief(posts, interests, { model }, { storiesMax: 1, quickHitsMax: 0 });
    expect(b?.stories.map((s) => ids(s.sources))).toEqual([["a", "b"]]);
    expect(b?.quickHits).toEqual([]);
    expect(ids(b?.leftovers ?? [])).toEqual(["c", "d"]);
  });

  it("keeps going when one step fails: a failed story becomes a quick hit, failed clustering means singles", async () => {
    const model = passes({ cluster: { nope: 1 }, story: (t) => (t.includes("text a") ? { title: "A", body: "B" } : { nope: 1 }) });
    const b = await buildBrief([post("a", 9), post("b", 8)], interests, { model });
    expect(b?.stories.map((s) => s.title)).toEqual(["A"]);
    expect(b?.quickHits.map((q) => q.post.id)).toEqual(["b"]);
    expect(b?.headlines).toEqual(["A"]);
  });

  it("returns null when every model call fails or there are no posts", async () => {
    const broken = new MockLanguageModelV4({ doGenerate: async () => reply({ nope: 1 }) });
    expect(await buildBrief(posts, interests, { model: broken })).toBeNull();
    expect(await buildBrief([], interests, { model: broken })).toBeNull();
  });

  it("needs no model call for a few weak posts, and uses their lines as headlines", async () => {
    const model = passes({});
    const b = await buildBrief([post("d", 5)], interests, { model });
    expect(model.doGenerateCalls).toHaveLength(0);
    expect(b?.headlines).toEqual(["summary d"]);
    expect(b?.stories).toEqual([]);
  });
});

describe("selectBriefPosts", () => {
  it("keeps best posts above the minimum score, up to the limit, skipping shown ones", () => {
    const all = [...posts, post("e", 4), post("f", 9, { shown_in: "2026-11-01" })];
    const got = selectBriefPosts(all, { brief_posts_max: 3, brief_min_score: 5 });
    expect(got.map((p) => p.id)).toEqual(["a", "b", "c"]);
  });
});
