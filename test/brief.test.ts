import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import type { InterestsConfig } from "../src/config.js";
import { buildBrief, briefPrompt, normalizeBrief } from "../src/pipeline/brief.js";
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

describe("normalizeBrief", () => {
  it("drops unknown and repeated ids, empty stories, and keeps uncovered posts as leftovers", () => {
    const b = normalizeBrief(
      {
        headlines: [" First ", ""],
        stories: [
          { topic: "AI", title: "One", body: "b", post_ids: ["a", "zzz", "b"] },
          { topic: "AI", title: "Dup", body: "b", post_ids: ["a"] },
          { topic: "AI", title: "Ghost", body: "b", post_ids: ["nope"] },
        ],
      },
      posts,
      interests,
    );
    expect(b.headlines).toEqual(["First"]);
    expect(b.stories.map((s) => [s.title, s.sources.map((p) => p.id)])).toEqual([["One", ["a", "b"]]]);
    expect(b.leftovers.map((p) => p.id)).toEqual(["c", "d"]);
  });

  it("keeps at most one headline per story, without duplicates", () => {
    const b = normalizeBrief(
      { headlines: ["A", "A", "B", "C"], stories: [
        { topic: "AI", title: "One", body: "", post_ids: ["a"] },
        { topic: "AI", title: "Two", body: "", post_ids: ["b"] },
      ] },
      posts,
      interests,
    );
    expect(b.headlines).toEqual(["A", "B"]);
  });

  it("orders by interests topic order then best score, and maps unknown topics to other", () => {
    const b = normalizeBrief(
      {
        headlines: ["h"],
        stories: [
          { topic: "Made up", title: "Other", body: "", post_ids: ["a"] },
          { topic: "Tooling", title: "Tools", body: "", post_ids: ["b"] },
          { topic: "AI", title: "Low AI", body: "", post_ids: ["d"] },
          { topic: "AI", title: "High AI", body: "", post_ids: ["c"] },
        ],
      },
      posts,
      interests,
    );
    expect(b.stories.map((s) => `${s.topic}:${s.title}`)).toEqual(["AI:High AI", "AI:Low AI", "Tooling:Tools", "other:Other"]);
  });

  it("turns quick hits into one-liners, with the same id rules, best score first", () => {
    const b = normalizeBrief(
      {
        headlines: ["h"],
        stories: [{ topic: "AI", title: "One", body: "", post_ids: ["a"] }],
        quick_hits: [
          { post_id: "d", line: " Low \n news " },
          { post_id: "a", line: "already in a story" },
          { post_id: "nope", line: "unknown" },
          { post_id: "b", line: "High news" },
          { post_id: "c", line: "  " },
        ],
      },
      posts,
      interests,
    );
    expect(b.quickHits.map((q) => [q.post.id, q.line])).toEqual([["b", "High news"], ["d", "Low news"]]);
    expect(b.leftovers.map((p) => p.id)).toEqual(["c"]);
  });

});

describe("brief system prompt", () => {
  it("asks the model to place every post in a story or a quick hit", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => reply({ headlines: ["h"], stories: [{ topic: "AI", title: "t", body: "", post_ids: ["a"] }] }),
    });
    await buildBrief(posts, interests, { model });
    const sent = JSON.stringify(model.doGenerateCalls[0]!.prompt);
    expect(sent).toContain("Every post id you were given must appear exactly once");
  });
});

describe("buildBrief", () => {
  it("asks the model once with every post and returns a normalized brief", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () =>
        reply({ headlines: ["Big news"], stories: [{ topic: "AI", title: "Big", body: "It happened.", post_ids: ["a", "c"] }] }),
    });
    const b = await buildBrief(posts, interests, { model });
    expect(model.doGenerateCalls).toHaveLength(1);
    const sent = JSON.stringify(model.doGenerateCalls[0]!.prompt);
    for (const id of ["a", "b", "c", "d"]) expect(sent).toContain(`id: ${id}`);
    expect(b?.stories[0]?.sources.map((p) => p.id)).toEqual(["a", "c"]);
    expect(b?.leftovers.map((p) => p.id)).toEqual(["b", "d"]);
  });

  it("returns null when the model fails, gives no usable story, or there are no posts", async () => {
    const broken = new MockLanguageModelV4({ doGenerate: async () => reply({ nope: 1 }) });
    expect(await buildBrief(posts, interests, { model: broken })).toBeNull();
    const empty = new MockLanguageModelV4({
      doGenerate: async () => reply({ headlines: ["x"], stories: [{ topic: "AI", title: "t", body: "", post_ids: ["unknown"] }] }),
    });
    expect(await buildBrief(posts, interests, { model: empty })).toBeNull();
    expect(await buildBrief([], interests, { model: empty })).toBeNull();
  });

  it("keeps the prompt compact: one line per field, text cut to 300 characters", () => {
    const p = briefPrompt([post("a", 9, { text: `line one\nline two ${"x".repeat(500)}` })], interests);
    expect(p).toContain("text: line one line two");
    expect(p).not.toContain("x".repeat(301));
  });
});

describe("selectBriefPosts", () => {
  it("keeps best posts above the minimum score, up to the limit, skipping shown ones", () => {
    const all = [...posts, post("e", 4), post("f", 9, { shown_in: "2026-11-01" })];
    const got = selectBriefPosts(all, { brief_posts_max: 3, brief_min_score: 5 });
    expect(got.map((p) => p.id)).toEqual(["a", "b", "c"]);
  });
});
