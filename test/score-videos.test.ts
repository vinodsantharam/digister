import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import type { ChannelsConfig, InterestsConfig } from "../src/config.js";
import { scoreVideos } from "../src/pipeline/score-videos.js";
import { openDb, upsertVideo, type Db } from "../src/store/db.js";

import { reply } from "./helpers.js";

const interests: InterestsConfig = { topics: [{ name: "AI", weight: 1, description: "ai stuff" }], mute: ["giveaway"] };
const channels: ChannelsConfig = {
  channels: [
    { id: "CM", name: "Must", tier: "must" },
    { id: "CH", name: "High", tier: "high" },
    { id: "CN", name: "Normal", tier: "normal" },
  ],
};
const since = "2026-11-01T00:00:00Z";

function seed(db: Db, id: string, channel: string, extra: Partial<Parameters<typeof upsertVideo>[1]> = {}) {
  upsertVideo(db, {
    id, channel_id: channel, channel_name: channel, title: `T ${id}`, url: `https://youtu.be/${id}`,
    published_at: "2026-11-02T00:00:00Z", ...extra,
  });
}
const row = (db: Db, id: string) => db.prepare("SELECT * FROM videos WHERE id = ?").get(id) as Record<string, unknown>;

/** Model that gives every video in the prompt the same score. */
const uniformModel = (score: number, mustWatch = false) =>
  new MockLanguageModelV4({
    doGenerate: async (opts) => {
      const text = JSON.stringify(opts.prompt);
      const ids = [...text.matchAll(/id: (\w+)/g)].map((m) => m[1]);
      return reply({ items: ids.map((id) => ({ id, score, must_watch: mustWatch, reason: "r" })) });
    },
  });

describe("scoreVideos", () => {
  it("adds the tier bonus and caps at 10", async () => {
    const db = openDb(":memory:");
    seed(db, "vm", "CM");
    seed(db, "vh", "CH");
    seed(db, "vn", "CN");
    seed(db, "vx", "CM");
    const model = new MockLanguageModelV4({
      doGenerate: async () =>
        reply({ items: [
          { id: "vm", score: 6, must_watch: false, reason: "a" },
          { id: "vh", score: 6, must_watch: false, reason: "b" },
          { id: "vn", score: 6, must_watch: false, reason: "c" },
          { id: "vx", score: 9.5, must_watch: false, reason: "d" },
        ] }),
    });
    await scoreVideos(db, { interests, channels, sinceIso: since, mustWatchMax: 3, llm: { model } });
    expect(row(db, "vm").score).toBe(8);
    expect(row(db, "vh").score).toBe(7);
    expect(row(db, "vn").score).toBe(6);
    expect(row(db, "vx").score).toBe(10);
    expect(row(db, "vm").reason).toBe("a");
  });

  it("scores muted videos 0 without asking the model", async () => {
    const db = openDb(":memory:");
    seed(db, "m1", "CM", { title: "Huge GIVEAWAY" });
    seed(db, "m2", "CN", { description: "enter the giveaway now" });
    const model = uniformModel(5);
    const r = await scoreVideos(db, { interests, channels, sinceIso: since, mustWatchMax: 3, llm: { model } });
    expect(model.doGenerateCalls).toHaveLength(0);
    expect(r.muted).toBe(2);
    expect(row(db, "m1")).toMatchObject({ score: 0, reason: "muted" });
  });

  it("skips Shorts unless the channel is must tier", async () => {
    const db = openDb(":memory:");
    seed(db, "s1", "CN", { is_short: 1 });
    seed(db, "s2", "CM", { is_short: 1 });
    const model = uniformModel(5);
    const r = await scoreVideos(db, { interests, channels, sinceIso: since, mustWatchMax: 3, llm: { model } });
    expect(r.shortsSkipped).toBe(1);
    expect(row(db, "s1").score).toBeNull();
    expect(row(db, "s2").score).toBe(7);
  });

  it("sends batches of 10", async () => {
    const db = openDb(":memory:");
    for (let i = 0; i < 23; i++) seed(db, `b${i}`, "CN");
    const model = uniformModel(5);
    const r = await scoreVideos(db, { interests, channels, sinceIso: since, mustWatchMax: 3, llm: { model } });
    expect(model.doGenerateCalls).toHaveLength(3);
    expect(r.batches).toBe(3);
    expect(r.scored).toBe(23);
  });

  it("enforces must_watch_max in code, best score first", async () => {
    const db = openDb(":memory:");
    for (const [id, ch] of [["a", "CN"], ["b", "CN"], ["c", "CM"], ["d", "CN"], ["e", "CN"]] as const) seed(db, id, ch);
    const model = new MockLanguageModelV4({
      doGenerate: async () =>
        reply({ items: [
          { id: "a", score: 9, must_watch: true, reason: "x" },
          { id: "b", score: 8, must_watch: true, reason: "x" },
          { id: "c", score: 7, must_watch: true, reason: "x" }, // 9 after bonus
          { id: "d", score: 6, must_watch: true, reason: "x" },
          { id: "e", score: 9, must_watch: false, reason: "x" },
        ] }),
    });
    await scoreVideos(db, { interests, channels, sinceIso: since, mustWatchMax: 2, llm: { model } });
    const flagged = ["a", "b", "c", "d", "e"].filter((id) => row(db, id).must_watch === 1);
    expect(flagged).toEqual(["a", "c"]);
  });

  it("leaves videos unscored when the model fails, and keeps going", async () => {
    const db = openDb(":memory:");
    seed(db, "f1", "CN");
    const model = new MockLanguageModelV4({ doGenerate: async () => { throw new Error("boom"); } });
    const r = await scoreVideos(db, { interests, channels, sinceIso: since, mustWatchMax: 3, llm: { model } });
    expect(r.unscored).toBe(1);
    expect(row(db, "f1").score).toBeNull();
  });
});
