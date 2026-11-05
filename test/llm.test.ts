import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { generateStructured, ollamaHealthy } from "../src/llm/client.js";
import { PostScoreBatch, VideoScoreBatch } from "../src/llm/schemas.js";

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};
const reply = (text: string) => ({
  content: [{ type: "text" as const, text }],
  finishReason: { unified: "stop" as const, raw: undefined },
  usage,
  warnings: [],
});

describe("schemas", () => {
  it("validates video and post batches", () => {
    expect(VideoScoreBatch.safeParse({ items: [{ id: "a", score: 7, must_watch: true, reason: "ok" }] }).success).toBe(true);
    expect(VideoScoreBatch.safeParse({ items: [{ id: "a", score: 11, must_watch: true, reason: "ok" }] }).success).toBe(false);
    expect(VideoScoreBatch.safeParse({ items: [{ id: "a", score: 1, must_watch: false, reason: "x".repeat(141) }] }).success).toBe(false);
    expect(PostScoreBatch.safeParse({ items: [{ id: "p", score: 3, topic: "other", summary: "s".repeat(201) }] }).success).toBe(false);
    expect(PostScoreBatch.safeParse({ items: [{ id: "p", score: 3, topic: "other", summary: "fine" }] }).success).toBe(true);
  });
});

describe("generateStructured", () => {
  const good = JSON.stringify({ items: [{ id: "v1", score: 8, must_watch: true, reason: "great" }] });

  it("parses a valid response and uses temperature 0.2", async () => {
    const model = new MockLanguageModelV4({ doGenerate: async () => reply(good) });
    const out = await generateStructured(VideoScoreBatch, "sys", "prompt", { model });
    expect(out.items[0]).toMatchObject({ id: "v1", score: 8 });
    expect(model.doGenerateCalls).toHaveLength(1);
    expect(model.doGenerateCalls[0]!.temperature).toBe(0.2);
  });

  it("retries once on schema failure, then succeeds", async () => {
    const model = new MockLanguageModelV4({ doGenerate: [reply("not json"), reply(good)] });
    const out = await generateStructured(VideoScoreBatch, "sys", "prompt", { model });
    expect(out.items).toHaveLength(1);
    expect(model.doGenerateCalls).toHaveLength(2);
  });

  it("gives up after the one retry", async () => {
    const bad = JSON.stringify({ items: [{ id: "v1", score: 99, must_watch: true, reason: "x" }] });
    const model = new MockLanguageModelV4({ doGenerate: [reply(bad), reply(bad), reply(good)] });
    await expect(generateStructured(VideoScoreBatch, "sys", "prompt", { model })).rejects.toThrow();
    expect(model.doGenerateCalls).toHaveLength(2);
  });
});

describe("ollamaHealthy", () => {
  const tags = (models: string[]) => (async () => new Response(JSON.stringify({ models: models.map((name) => ({ name })) }))) as typeof fetch;
  const base = { baseUrl: "http://localhost:11434/", model: "qwen3:8b" };

  it("ok when the model is pulled", async () => {
    const s = await ollamaHealthy({ ...base, fetchFn: tags(["llama3:8b", "qwen3:8b"]) });
    expect(s).toMatchObject({ reachable: true, modelPulled: true, ok: true, baseUrl: "http://localhost:11434" });
  });
  it("reachable but model missing", async () => {
    const s = await ollamaHealthy({ ...base, fetchFn: tags(["llama3:8b"]) });
    expect(s).toMatchObject({ reachable: true, modelPulled: false, ok: false });
    expect(s.error).toContain("ollama pull qwen3:8b");
  });
  it("matches :latest for untagged names", async () => {
    expect((await ollamaHealthy({ ...base, model: "llama3", fetchFn: tags(["llama3:latest"]) })).ok).toBe(true);
  });
  it("not reachable", async () => {
    const s = await ollamaHealthy({ ...base, fetchFn: (async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch });
    expect(s).toMatchObject({ reachable: false, ok: false });
    expect(s.error).toContain("ECONNREFUSED");
  });
});
