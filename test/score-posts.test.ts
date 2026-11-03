import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import type { InterestsConfig } from "../src/config.js";
import { scorePosts } from "../src/pipeline/score-posts.js";
import { openDb, upsertPost, type Db } from "../src/store/db.js";
import { reply } from "./helpers.js";

const interests: InterestsConfig = { topics: [{ name: "AI", weight: 1, description: "ai" }], mute: ["giveaway"] };
const since = "2026-11-01T00:00:00Z";

function seed(db: Db, id: string, over: Partial<Parameters<typeof upsertPost>[1]> = {}) {
  upsertPost(db, {
    id, author_handle: "alice", author_name: "Alice", text: `text ${id}`, url: `https://x.com/alice/status/${id}`,
    created_at: `2026-11-02T00:0${id.length > 1 ? 0 : id}:00Z`, ...over,
  });
}
const row = (db: Db, id: string) => db.prepare("SELECT * FROM posts WHERE id = ?").get(id) as Record<string, unknown>;

const uniform = () =>
  new MockLanguageModelV4({
    doGenerate: async (opts) => {
      const ids = [...JSON.stringify(opts.prompt).matchAll(/id: (\w+)/g)].map((m) => m[1]);
      return reply({ items: ids.map((id) => ({ id, score: 6, topic: "AI", summary: "sum" })) });
    },
  });

describe("scorePosts", () => {
  it("drops muted posts with score 0 and never asks the model", async () => {
    const db = openDb(":memory:");
    seed(db, "1", { text: "Big GIVEAWAY today" });
    const model = uniform();
    const r = await scorePosts(db, { interests, sinceIso: since, llm: { model } });
    expect(r.muted).toBe(1);
    expect(model.doGenerateCalls).toHaveLength(0);
    expect(row(db, "1")).toMatchObject({ score: 0, summary: "muted" });
  });

  it("drops replies to other people but keeps self-replies", async () => {
    const db = openDb(":memory:");
    seed(db, "1", { author_handle: "bob" });
    seed(db, "2", { reply_to_id: "1" }); // alice replies to bob
    seed(db, "3"); // alice root
    seed(db, "4", { reply_to_id: "3" }); // alice replies to herself
    seed(db, "5", { reply_to_id: "999" }); // parent unknown: not provably a thread
    const r = await scorePosts(db, { interests, sinceIso: since, llm: { model: uniform() } });
    expect(r.repliesDropped).toBe(2);
    expect(row(db, "2").score).toBe(0);
    expect(row(db, "5").score).toBe(0);
    expect(row(db, "4").score).toBe(6);
    expect(row(db, "1").score).toBe(6);
  });

  it("merges a self-thread into one item with joined text", async () => {
    const db = openDb(":memory:");
    seed(db, "1", { conversation_id: "1", text: "part one", created_at: "2026-11-02T01:00:00Z" });
    seed(db, "2", { conversation_id: "1", reply_to_id: "1", text: "part two", created_at: "2026-11-02T01:01:00Z" });
    seed(db, "3", { conversation_id: "1", author_handle: "bob", text: "someone else", created_at: "2026-11-02T01:02:00Z" });
    const model = uniform();
    const r = await scorePosts(db, { interests, sinceIso: since, llm: { model } });
    expect(r.merged).toBe(1);
    expect(r.scored).toBe(2);
    expect(row(db, "1").text).toBe("part one\n\npart two");
    expect(row(db, "1").score).toBe(6);
    expect(row(db, "2")).toMatchObject({ score: 0 });
    const sent = JSON.stringify(model.doGenerateCalls[0]!.prompt);
    expect(sent).toContain("thread of 2 posts");
    expect(sent).not.toContain("id: 2");
  });

  it("batches by 15 and normalizes unknown topics to other", async () => {
    const db = openDb(":memory:");
    for (let i = 0; i < 31; i++) seed(db, `p${i}`, { created_at: `2026-11-02T01:${String(i).padStart(2, "0")}:00Z` });
    const model = new MockLanguageModelV4({
      doGenerate: async (opts) => {
        const ids = [...JSON.stringify(opts.prompt).matchAll(/id: (\w+)/g)].map((m) => m[1]);
        return reply({ items: ids.map((id) => ({ id, score: 5, topic: "Made up", summary: "s" })) });
      },
    });
    const r = await scorePosts(db, { interests, sinceIso: since, llm: { model } });
    expect(model.doGenerateCalls).toHaveLength(3);
    expect(r.scored).toBe(31);
    expect(row(db, "p0").topic).toBe("other");
  });
});
