import { beforeEach, describe, expect, it } from "vitest";
import {
  finishRun, markShown, openDb, setPostScore, setVideoScore, startRun,
  unscoredPosts, unscoredVideos, upsertPost, upsertVideo, type Db,
} from "../src/store/db.js";

const video = (id: string, extra = {}) => ({
  id, channel_id: "UC1", channel_name: "Chan", title: `T ${id}`,
  url: `https://www.youtube.com/watch?v=${id}`, published_at: "2026-11-03T00:00:00.000Z", ...extra,
});
const post = (id: string, extra = {}) => ({
  id, author_handle: "a", author_name: "A", text: "hi", url: `https://x.com/a/status/${id}`,
  created_at: "2026-11-03T00:00:00.000Z", ...extra,
});
const SINCE = "2026-11-01T00:00:00.000Z";

let db: Db;
beforeEach(() => { db = openDb(":memory:"); });

describe("store", () => {
  it("applies the schema idempotently", () => {
    expect(() => db.exec("SELECT 1 FROM videos, posts, runs")).not.toThrow();
  });

  it("upsertVideo is idempotent, keeps first_seen_at and score, fills enrichment", () => {
    upsertVideo(db, video("a", { first_seen_at: "2026-11-02T00:00:00.000Z" }));
    setVideoScore(db, "a", 7, "good");
    upsertVideo(db, video("a", { first_seen_at: "2026-11-03T00:00:00.000Z", duration_s: 90 }));
    const rows = db.prepare("SELECT * FROM videos").all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ first_seen_at: "2026-11-02T00:00:00.000Z", score: 7, duration_s: 90 });
    upsertVideo(db, video("a")); // later feed refresh must not erase duration
    expect((db.prepare("SELECT duration_s FROM videos").get() as any).duration_s).toBe(90);
  });

  it("upsertPost ignores duplicates and keeps the first first_seen_at", () => {
    upsertPost(db, post("1", { first_seen_at: "2026-11-02T00:00:00.000Z", text: "first" }));
    upsertPost(db, post("1", { first_seen_at: "2026-11-03T00:00:00.000Z", text: "second" }));
    const rows = db.prepare("SELECT * FROM posts").all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ text: "first", first_seen_at: "2026-11-02T00:00:00.000Z" });
  });

  it("unscored queries exclude scored, shown and old items", () => {
    for (const id of ["a", "b", "c"]) upsertVideo(db, video(id));
    upsertVideo(db, video("old", { published_at: "2026-10-01T00:00:00.000Z" }));
    setVideoScore(db, "b", 5, "ok");
    markShown(db, "video", ["c"], "2026-11-03");
    expect(unscoredVideos(db, SINCE).map((v) => v.id)).toEqual(["a"]);

    for (const id of ["1", "2", "3"]) upsertPost(db, post(id));
    setPostScore(db, "2", 6, "AI", "sum");
    markShown(db, "post", ["3"], "2026-11-03");
    expect(unscoredPosts(db, SINCE).map((p) => p.id)).toEqual(["1"]);
  });

  it("an item marked shown is excluded from the next selection query", () => {
    upsertVideo(db, video("a"));
    expect(unscoredVideos(db, SINCE)).toHaveLength(1);
    markShown(db, "video", ["a"], "2026-11-03");
    expect(unscoredVideos(db, SINCE)).toHaveLength(0);
    expect((db.prepare("SELECT shown_in FROM videos").get() as any).shown_in).toBe("2026-11-03");
  });

  it("records runs", () => {
    const id = startRun(db);
    finishRun(db, id, { status: "ok", videos_seen: 4, digest_path: "/x.html" });
    expect(db.prepare("SELECT * FROM runs WHERE id = ?").get(id)).toMatchObject({
      status: "ok", videos_seen: 4, digest_path: "/x.html",
    });
  });
});
