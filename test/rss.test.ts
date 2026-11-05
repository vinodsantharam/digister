import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { collectVideos, fetchChannelFeed, parseFeed } from "../src/sources/youtube/rss.js";
import { openDb } from "../src/store/db.js";

process.env.DIGISTER_HOME = path.resolve("node_modules/.cache/digister-test-home");
const xml = readFileSync(path.resolve("test/fixtures/youtube-feed.xml"), "utf8");
const ok = () => new Response(xml, { status: 200 });

describe("rss", () => {
  it("parses the fixture feed", () => {
    const entries = parseFeed(xml);
    expect(entries).toHaveLength(3);
    expect(entries[0]).toEqual({
      id: "aaaaaaaaa01",
      title: "New open-weight model beats the giants & runs locally",
      published_at: "2026-11-03T08:00:00.000Z",
      author: "Fireship",
      description: "An open-weight model just landed.\nSecond line of the description with a link https://example.com/post",
      thumbnail_url: "https://i2.ytimg.com/vi/aaaaaaaaa01/hqdefault.jpg",
      url: "https://www.youtube.com/watch?v=aaaaaaaaa01",
      is_short: null,
    });
    expect(entries[1]).toMatchObject({ id: "bbbbbbbbb02", is_short: 1 });
    expect(entries[2]!.description).toBe("");
  });

  it("rejects a non-feed payload", () => {
    expect(() => parseFeed("<html></html>")).toThrow();
  });

  it("retries once on a network error but not on HTTP errors", async () => {
    let calls = 0;
    const flaky = (async () => {
      if (calls++ === 0) throw new TypeError("fetch failed");
      return ok();
    }) as unknown as typeof fetch;
    expect(await fetchChannelFeed({ id: "UC1", name: "a" }, flaky)).toHaveLength(3);
    expect(calls).toBe(2);

    calls = 0;
    const http500 = (async () => { calls++; return new Response("", { status: 500 }); }) as unknown as typeof fetch;
    await expect(fetchChannelFeed({ id: "UC1", name: "a" }, http500)).rejects.toThrow(/500/);
    expect(calls).toBe(1);
  });

  it("keeps only entries inside the lookback window, skips failing channels, caps concurrency", async () => {
    let active = 0;
    let peak = 0;
    const fetchFn = (async (url: string) => {
      active++; peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      if (String(url).includes("BAD")) return new Response("", { status: 404 });
      return ok();
    }) as unknown as typeof fetch;
    const channels = [
      ...Array.from({ length: 8 }, (_, i) => ({ id: `UCgood${i}`, name: `good${i}` })),
      { id: "UCBAD", name: "bad" },
    ];
    const db = openDb(":memory:");
    const r = await collectVideos(db, channels, {
      lookbackHours: 36, fetchFn, now: new Date("2026-11-03T12:00:00Z"),
    });
    expect(peak).toBeLessThanOrEqual(4);
    expect(r.failed).toEqual(["bad"]);
    // 2 recent entries per good channel; the same video ids collapse in the db per id
    expect(r.videos).toBe(16);
    const rows = db.prepare("SELECT id, is_short FROM videos ORDER BY id").all();
    expect(rows).toEqual([{ id: "aaaaaaaaa01", is_short: null }, { id: "bbbbbbbbb02", is_short: 1 }]);
  });
});
