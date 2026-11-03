import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { enrichVideos, parseIsoDuration, parseVideosResponse } from "../src/sources/youtube/enrich.js";
import { openDb, upsertVideo } from "../src/store/db.js";

process.env.DIGISTER_HOME = path.resolve("node_modules/.cache/digister-test-home");
const fixture = JSON.parse(readFileSync(path.resolve("test/fixtures/videos-list.json"), "utf8"));
const video = (id: string, extra = {}) => ({
  id, channel_id: "UC1", channel_name: "C", title: id, url: `https://www.youtube.com/watch?v=${id}`,
  published_at: "2026-11-03T00:00:00.000Z", ...extra,
});

describe("parseIsoDuration", () => {
  it.each([
    ["PT1H2M3S", 3723], ["PT58S", 58], ["PT12M", 720], ["PT2H", 7200], ["P1DT1S", 86401], ["PT0S", 0],
  ])("%s -> %i", (iso, s) => expect(parseIsoDuration(iso)).toBe(s));

  it.each(["", "P", "PT", "1H", "garbage"])("rejects %j", (iso) =>
    expect(parseIsoDuration(iso)).toBeNull());
});

describe("enrichment", () => {
  it("parses the recorded response", () => {
    expect(parseVideosResponse(fixture)).toEqual([
      { id: "aaaaaaaaa01", duration_s: 3723, view_count: 250000 },
      { id: "bbbbbbbbb02", duration_s: 58, view_count: 48000 },
      { id: "ccccccccc03", duration_s: 720, view_count: null },
    ]);
  });

  it("updates the db, batches 50 ids, and only sets is_short when unknown", async () => {
    const db = openDb(":memory:");
    upsertVideo(db, video("aaaaaaaaa01"));
    upsertVideo(db, video("bbbbbbbbb02"));
    upsertVideo(db, video("ccccccccc03", { is_short: 1 })); // heuristic already said short
    for (let i = 0; i < 52; i++) upsertVideo(db, video(`x${String(i).padStart(10, "0")}`));
    const urls: string[] = [];
    const fetchFn = (async (url: string) => {
      urls.push(url);
      return Response.json(fixture);
    }) as unknown as typeof fetch;
    await enrichVideos(db, { apiKey: "k", fetchFn });
    expect(urls).toHaveLength(2); // 55 ids -> 50 + 5
    const first = new URL(urls[0]!);
    expect(first.searchParams.get("part")).toBe("contentDetails,statistics");
    expect(first.searchParams.get("id")!.split(",")).toHaveLength(50);
    expect(first.searchParams.get("key")).toBe("k");
    const row = (id: string) => db.prepare("SELECT duration_s, view_count, is_short FROM videos WHERE id = ?").get(id);
    expect(row("aaaaaaaaa01")).toEqual({ duration_s: 3723, view_count: 250000, is_short: 0 });
    expect(row("bbbbbbbbb02")).toEqual({ duration_s: 58, view_count: 48000, is_short: 1 });
    expect(row("ccccccccc03")).toEqual({ duration_s: 720, view_count: null, is_short: 1 });
  });

  it("does nothing without a key", async () => {
    const db = openDb(":memory:");
    upsertVideo(db, video("a"));
    const fetchFn = (async () => { throw new Error("must not be called"); }) as unknown as typeof fetch;
    expect(await enrichVideos(db, { apiKey: "", fetchFn })).toBe(0);
  });

  it("swallows API errors and bad payloads", async () => {
    const db = openDb(":memory:");
    upsertVideo(db, video("a"));
    const http403 = (async () => new Response("quota", { status: 403 })) as unknown as typeof fetch;
    expect(await enrichVideos(db, { apiKey: "k", fetchFn: http403 })).toBe(0);
    const garbage = (async () => Response.json({ items: "nope" })) as unknown as typeof fetch;
    expect(await enrichVideos(db, { apiKey: "k", fetchFn: garbage })).toBe(0);
    const net = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
    expect(await enrichVideos(db, { apiKey: "k", fetchFn: net })).toBe(0);
  });
});
