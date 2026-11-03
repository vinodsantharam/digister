import { MockLanguageModelV4 } from "ai/test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireLock, runPipeline, type RunDeps } from "../src/pipeline/run.js";
import type { CaptureResult } from "../src/sources/x/capture.js";
import Database from "better-sqlite3";
import { reply } from "./helpers.js";

const feed = (id: string, title: string, published: string) => `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">
 <entry><yt:videoId>${id}</yt:videoId><title>${title}</title>
  <link rel="alternate" href="https://www.youtube.com/watch?v=${id}"/><author><name>Fireship</name></author>
  <published>${published}</published>
  <media:group><media:thumbnail url="https://i.ytimg.com/vi/${id}/hqdefault.jpg"/><media:description>About ${title}</media:description></media:group>
 </entry></feed>`;

const NOW = new Date("2026-11-03T06:00:00Z");
let home: string;
let out: string;
let lines: string[];
const prevHome = process.env.DIGISTER_HOME;

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "digister-run-"));
  out = path.join(home, "phone");
  mkdirSync(path.join(home, "config"), { recursive: true });
  process.env.DIGISTER_HOME = home;
  lines = [];
  const cfg = (n: string, body: string) => writeFileSync(path.join(home, "config", `${n}.yaml`), body);
  cfg("digister", `output_dir: "${out}"\nx:\n  list_urls: ["https://x.com/i/lists/1"]\n`);
  cfg("channels", `channels:\n  - {id: "UCMUST", name: "Fireship", tier: must}\n  - {id: "UCNORM", name: "Other", tier: normal}\n`);
  cfg("interests", `topics:\n  - {name: "AI", weight: 1, description: "ai"}\nmute: ["giveaway"]\n`);
});
afterEach(() => {
  if (prevHome === undefined) delete process.env.DIGISTER_HOME;
  else process.env.DIGISTER_HOME = prevHome;
});

const fetchFn: typeof fetch = async (url) => {
  const u = String(url);
  const xml = u.includes("UCMUST")
    ? feed("vid1", "Local LLMs are here", "2026-11-03T01:00:00Z")
    : feed("vid2", "Huge giveaway", "2026-11-03T02:00:00Z");
  return new Response(xml, { status: 200 });
};

const model = () =>
  new MockLanguageModelV4({
    doGenerate: async (opts) => {
      const text = JSON.stringify(opts.prompt);
      if (text.includes("Posts:"))
        return reply({ items: [{ id: "p1", score: 8, topic: "AI", summary: "Alice ships a thing." }] });
      return reply({ items: [{ id: "vid1", score: 8, must_watch: true, reason: "Great match" }] });
    },
  });

const xResult = (over: Partial<CaptureResult> = {}): CaptureResult => ({
  status: "ok",
  posts: [{
    id: "p1", author_handle: "alice", author_name: "Alice", text: "I shipped a local agent", url: "https://x.com/alice/status/p1",
    created_at: "2026-11-03T03:00:00.000Z",
  }],
  stops: ["lookback"], operationsSeen: ["ListLatestTweetsTimeline"], matchedResponses: 1, ...over,
});

const deps = (over: Partial<RunDeps> = {}): RunDeps => ({
  fetchFn,
  captureX: async () => xResult(),
  llm: { model: model() },
  health: async () => ({ reachable: true, modelPulled: true, ok: true, model: "qwen3:8b", baseUrl: "http://x" }),
  now: () => NOW,
  out: (l) => lines.push(l),
  ...over,
});

describe("runPipeline", () => {
  it("writes a digest from RSS, X and the model, and marks items shown", async () => {
    const r = await runPipeline({}, deps());
    expect(r.exitCode).toBe(0);
    const html = readFileSync(path.join(out, "digest-2026-11-03.html"), "utf8");
    expect(existsSync(path.join(out, "latest.html"))).toBe(true);
    expect(html).toContain("Local LLMs are here");
    expect(html).toContain("Great match");
    expect(html).toContain("Alice ships a thing.");
    expect(html).not.toContain("giveaway");
    expect(html.toLowerCase()).not.toContain("<script");
    expect(existsSync(path.join(home, "run.lock"))).toBe(false);

    const db = new Database(path.join(home, "digister.db"), { readonly: true });
    expect(db.prepare("SELECT shown_in FROM videos WHERE id='vid1'").get()).toEqual({ shown_in: "2026-11-03" });
    expect(db.prepare("SELECT status, x_posts_seen, videos_seen FROM runs").get()).toEqual({ status: "ok", x_posts_seen: 1, videos_seen: 2 });
    db.close();

    // A second run has nothing new to show.
    const again = await runPipeline({}, deps({ llm: { model: new MockLanguageModelV4({ doGenerate: async () => reply({ items: [] }) }) } }));
    expect(again.exitCode).toBe(0);
    expect(readFileSync(path.join(out, "digest-2026-11-03.html"), "utf8")).toContain("Local LLMs are here");
    expect(readFileSync(path.join(out, "digest-2026-11-03-2.html"), "utf8")).not.toContain("Local LLMs are here");
    expect(readFileSync(path.join(out, "latest.html"), "utf8")).not.toContain("Local LLMs are here");
  });

  it("still writes a digest, with a header warning, when X needs login", async () => {
    const r = await runPipeline({}, deps({ captureX: async () => xResult({ status: "needs_login", posts: [], matchedResponses: 0 }) }));
    expect(r.exitCode).toBe(0);
    const html = readFileSync(path.join(out, "digest-2026-11-03.html"), "utf8");
    expect(html).toContain("X needs login");
    expect(html).toContain("Local LLMs are here");
  });

  it("warns instead of failing when X throws or YouTube feeds fail", async () => {
    const r = await runPipeline({}, deps({
      captureX: async () => { throw new Error("browser crashed"); },
      fetchFn: async () => new Response("nope", { status: 500 }),
    }));
    expect(r.exitCode).toBe(0);
    const html = readFileSync(path.join(out, "digest-2026-11-03.html"), "utf8");
    expect(html).toContain("X failed: browser crashed");
    expect(html).toContain("YouTube feeds failed");
  });

  it("warns when X is disabled", async () => {
    writeFileSync(path.join(home, "config", "digister.yaml"), `output_dir: "${out}"\nx:\n  enabled: false\n`);
    let called = false;
    const r = await runPipeline({}, deps({ captureX: async () => { called = true; return xResult(); } }));
    expect(r.exitCode).toBe(0);
    expect(called).toBe(false);
    expect(readFileSync(path.join(out, "digest-2026-11-03.html"), "utf8")).toContain("X is disabled");
  });

  it("fails with exit 1 and no digest when Ollama is down, after trying to start it once", async () => {
    let started = 0;
    const r = await runPipeline({}, deps({
      health: async () => ({ reachable: false, modelPulled: false, ok: false, model: "qwen3:8b", baseUrl: "http://x", error: "cannot reach Ollama" }),
      startOllama: async () => { started++; },
    }));
    expect(r.exitCode).toBe(1);
    expect(started).toBe(1);
    expect(lines.join("\n")).toContain("Ollama is not ready");
    expect(existsSync(out)).toBe(false);
    expect(existsSync(path.join(home, "run.lock"))).toBe(false);
  });

  it("does not start Ollama when it is up but the model is missing", async () => {
    let started = 0;
    const r = await runPipeline({}, deps({
      health: async () => ({ reachable: true, modelPulled: false, ok: false, model: "qwen3:8b", baseUrl: "http://x", error: "model qwen3:8b is not pulled" }),
      startOllama: async () => { started++; },
    }));
    expect(r.exitCode).toBe(1);
    expect(started).toBe(0);
  });

  it("refuses to run while another run holds the lock", async () => {
    const release = acquireLock(home);
    const r = await runPipeline({}, deps());
    release();
    expect(r.exitCode).toBe(1);
    expect(lines.join("\n")).toContain("in progress");
  });

  it("--dry makes no LLM calls, no X capture and writes no digest or db", async () => {
    const m = model();
    let xCalls = 0;
    const r = await runPipeline({ dry: true }, deps({ llm: { model: m }, captureX: async () => { xCalls++; return xResult(); } }));
    expect(r.exitCode).toBe(0);
    expect(m.doGenerateCalls).toHaveLength(0);
    expect(xCalls).toBe(0);
    expect(existsSync(out)).toBe(false);
    expect(existsSync(path.join(home, "digister.db"))).toBe(false);
    const text = lines.join("\n");
    expect(text).toContain("2 videos");
    expect(text).toContain("1 muted");
  });

  it("reports a config problem as exit 1", async () => {
    writeFileSync(path.join(home, "config", "digister.yaml"), "x:\n  enabled: true\n");
    const r = await runPipeline({}, deps());
    expect(r.exitCode).toBe(1);
    expect(lines.join("\n")).toContain("output_dir");
  });
});

describe("acquireLock", () => {
  it("replaces a lock whose process is gone", () => {
    writeFileSync(path.join(home, "run.lock"), JSON.stringify({ pid: 2 ** 30, started: NOW.toISOString() }));
    const release = acquireLock(home, NOW.getTime());
    expect(existsSync(path.join(home, "run.lock"))).toBe(true);
    release();
  });
});
