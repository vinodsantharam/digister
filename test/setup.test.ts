import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { isXListUrl, runSetup, suggestedOutputDir } from "../src/setup.js";

const repo = new URL("../config/", import.meta.url).pathname;
const prev = process.env.DIGISTER_HOME;
let home: string;
beforeEach(() => {
  home = path.join(mkdtempSync(path.join(tmpdir(), "digister-setup-")), ".digister");
  process.env.DIGISTER_HOME = home;
});
afterEach(() => {
  if (prev === undefined) delete process.env.DIGISTER_HOME;
  else process.env.DIGISTER_HOME = prev;
});

function script(answers: string[]) {
  const said: string[] = [];
  const asked: string[] = [];
  const queue = [...answers];
  return {
    said,
    asked,
    io: {
      ask: async (q: string, def?: string) => {
        asked.push(q);
        const a = queue.shift() ?? "";
        return a || def || "";
      },
      say: (m: string) => void said.push(m),
    },
  };
}
const cfgPath = (n: string) => path.join(home, "config", `${n}.yaml`);
const noChecks = async () => [{ name: "Node", status: "ok" as const, detail: "v22" }];

describe("isXListUrl", () => {
  it("accepts list addresses only", () => {
    expect(isXListUrl("https://x.com/i/lists/1234567890")).toBe(true);
    expect(isXListUrl("https://twitter.com/i/lists/42/")).toBe(true);
    expect(isXListUrl("https://x.com/i/lists/abc")).toBe(false);
    expect(isXListUrl("https://x.com/someone")).toBe(false);
    expect(isXListUrl("x.com/i/lists/1")).toBe(false);
  });
});

describe("runSetup", () => {
  it("creates config, writes answers, keeps comments, and prints next steps", async () => {
    const s = script(["/tmp/phone-sync", "not a url", "https://x.com/i/lists/987654321"]);
    const r = await runSetup({ io: s.io, repoConfigDir: repo, doctor: noChecks });
    expect(r.copied.map((f) => path.basename(f)).sort()).toEqual(["channels.yaml", "digister.yaml", "interests.yaml"]);
    const text = readFileSync(cfgPath("digister"), "utf8");
    expect(text).toContain("# any folder synced to the phone");
    expect(text).toContain("# Copy to");
    const cfg = parse(text);
    expect(cfg.output_dir).toBe("/tmp/phone-sync");
    expect(cfg.x.list_urls).toEqual(["https://x.com/i/lists/987654321"]);
    expect(cfg.x.enabled).toBe(true);
    // channels.yaml comes from the repo's real list, not the example
    expect(readFileSync(cfgPath("channels"), "utf8")).toBe(readFileSync(path.join(repo, "channels.yaml"), "utf8"));
    expect(s.said.join("\n")).toMatch(/does not look like an X List/);
    expect(s.said.join("\n")).toMatch(/digister x login[\s\S]*run --dry[\s\S]*digister run /);
    expect(s.said.join("\n")).toContain("[ok  ] Node");
  });

  it("skipping the List disables X and omits the login step", async () => {
    const s = script(["", ""]);
    const r = await runSetup({ io: s.io, repoConfigDir: repo, platform: "linux", doctor: noChecks });
    expect(r.listUrl).toBeNull();
    const cfg = parse(readFileSync(cfgPath("digister"), "utf8"));
    expect(cfg.x.enabled).toBe(false);
    expect(cfg.output_dir).toBe(suggestedOutputDir("linux"));
    expect(s.said.join("\n")).not.toContain("x login");
  });

  it("never overwrites existing files and defaults to the existing output folder", async () => {
    mkdirSync(path.join(home, "config"), { recursive: true });
    writeFileSync(cfgPath("digister"), 'output_dir: "/mine"  # keep me\nx:\n  list_urls: []\n');
    writeFileSync(cfgPath("channels"), "channels: []\n");
    const s = script(["", "https://x.com/i/lists/5"]);
    const r = await runSetup({ io: s.io, repoConfigDir: repo, doctor: noChecks });
    expect(r.copied.map((f) => path.basename(f))).toEqual(["interests.yaml"]);
    expect(readFileSync(cfgPath("channels"), "utf8")).toBe("channels: []\n");
    const text = readFileSync(cfgPath("digister"), "utf8");
    expect(text).toContain("# keep me");
    expect(parse(text)).toMatchObject({ output_dir: "/mine", x: { enabled: true, list_urls: ["https://x.com/i/lists/5"] } });
    expect(existsSync(cfgPath("interests"))).toBe(true);
  });

  it("suggests the iCloud Drive folder on macOS", () => {
    expect(suggestedOutputDir("darwin")).toContain("com~apple~CloudDocs");
    expect(suggestedOutputDir("linux")).not.toContain("CloudDocs");
  });
});
