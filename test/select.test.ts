import { describe, expect, it } from "vitest";
import type { ChannelsConfig, InterestsConfig } from "../src/config.js";
import { selectPosts, selectVideos } from "../src/pipeline/select.js";
import { markShown, openDb, selectablePosts, selectableVideos, setPostScore, setVideoScore, upsertPost, upsertVideo, type Post, type Video } from "../src/store/db.js";

const channels: ChannelsConfig = {
  channels: [
    { id: "CM", name: "m", tier: "must" },
    { id: "CH", name: "h", tier: "high" },
    { id: "CN", name: "n", tier: "normal" },
  ],
};
const video = (id: string, over: Partial<Video> = {}): Video => ({
  id, channel_id: "CN", channel_name: "c", title: id, description: "", url: "u", thumbnail_url: null,
  published_at: "2026-11-02T00:00:00Z", duration_s: null, view_count: null, is_short: null,
  first_seen_at: "", score: 5, reason: "r", scored_at: "", shown_in: null, must_watch: 0, ...over,
});
const post = (id: string, over: Partial<Post> = {}): Post => ({
  id, author_handle: "a", author_name: "A", text: "word ".repeat(20), url: "u", created_at: "2026-11-02T00:00:00Z",
  lang: null, reply_to_id: null, quoted_id: null, conversation_id: null, like_count: 0, repost_count: 0,
  media_json: "[]", links_json: "[]", source: null, first_seen_at: "", score: 5, topic: "other", summary: "short summary",
  scored_at: "", shown_in: null, ...over,
});

describe("selectVideos", () => {
  it("limits must-watch, ranks by score, and uses flagged or score >= 8", () => {
    const vs = [
      video("a", { score: 9 }), video("b", { score: 8.5 }), video("c", { score: 9.5 }), video("d", { score: 8.2 }),
      video("e", { score: 6, must_watch: 1 }), video("f", { score: 7 }),
    ];
    const r = selectVideos(vs, channels, { must_watch_max: 3 });
    expect(r.mustWatch.map((v) => v.id)).toEqual(["c", "a", "b"]);
  });

  it("also-new takes remaining must/high videos newest first, max 10", () => {
    const vs = [
      video("w", { score: 9, channel_id: "CM" }),
      ...Array.from({ length: 12 }, (_, i) => video(`h${i}`, { channel_id: "CH", published_at: `2026-11-02T${String(i).padStart(2, "0")}:00:00Z` })),
      video("n", { channel_id: "CN", published_at: "2026-11-02T23:00:00Z" }),
    ];
    const r = selectVideos(vs, channels, { must_watch_max: 1 });
    expect(r.mustWatch.map((v) => v.id)).toEqual(["w"]);
    expect(r.alsoNew).toHaveLength(10);
    expect(r.alsoNew[0]!.id).toBe("h11");
    expect(r.alsoNew.some((v) => v.id === "n")).toBe(false);
  });

  it("excludes shown, muted (score 0) and unscored videos", () => {
    const vs = [video("s", { score: 9, shown_in: "2026-11-01" }), video("m", { score: 0, channel_id: "CM" }), video("u", { score: null, channel_id: "CM" })];
    const r = selectVideos(vs, channels, { must_watch_max: 3 });
    expect(r.mustWatch).toEqual([]);
    expect(r.alsoNew).toEqual([]);
  });
});

describe("selectPosts", () => {
  const interests: InterestsConfig = { topics: [{ name: "AI", weight: 1, description: "" }, { name: "Web", weight: 1, description: "" }], mute: [] };

  it("caps at posts_max, best first, grouped in interests order with other last", () => {
    const ps = [
      post("1", { score: 9, topic: "other" }), post("2", { score: 8, topic: "Web" }), post("3", { score: 7, topic: "AI" }),
      post("4", { score: 6, topic: "AI" }), post("5", { score: 1, topic: "AI" }),
    ];
    const r = selectPosts(ps, interests, { posts_max: 4, reading_minutes: 60 });
    expect(r.count).toBe(4);
    expect(r.groups.map((g) => g.topic)).toEqual(["AI", "Web", "other"]);
    expect(r.groups[0]!.posts.map((p) => p.id)).toEqual(["3", "4"]);
  });

  it("stops at the reading budget", () => {
    const long = "word ".repeat(400); // 2 minutes each
    const ps = [1, 2, 3, 4].map((i) => post(String(i), { text: long, summary: "", score: 10 - i }));
    const r = selectPosts(ps, interests, { posts_max: 20, reading_minutes: 5 });
    expect(r.count).toBe(2);
    expect(r.readingMinutes).toBe(4);
  });

  it("never selects shown posts", () => {
    const r = selectPosts([post("1", { shown_in: "2026-11-01", score: 9 })], interests, { posts_max: 5, reading_minutes: 30 });
    expect(r.count).toBe(0);
  });
});

describe("shown exclusion in the store", () => {
  it("marked items drop out of the selectable queries", () => {
    const db = openDb(":memory:");
    upsertVideo(db, { id: "v", channel_id: "CM", channel_name: "c", title: "t", url: "u", published_at: "2026-11-02T00:00:00Z" });
    upsertPost(db, { id: "p", author_handle: "a", author_name: "A", text: "t", url: "u", created_at: "2026-11-02T00:00:00Z" });
    setVideoScore(db, "v", 9, "r");
    setPostScore(db, "p", 9, "other", "s");
    expect(selectableVideos(db, "2026-11-01T00:00:00Z")).toHaveLength(1);
    expect(selectablePosts(db, "2026-11-01T00:00:00Z")).toHaveLength(1);
    markShown(db, "video", ["v"], "2026-11-03");
    markShown(db, "post", ["p"], "2026-11-03");
    expect(selectableVideos(db, "2026-11-01T00:00:00Z")).toHaveLength(0);
    expect(selectablePosts(db, "2026-11-01T00:00:00Z")).toHaveLength(0);
  });
});
