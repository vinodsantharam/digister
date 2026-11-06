import { copyFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadChannels, loadDigisterConfig, loadInterests } from "../src/config.js";

// Copy the shipped *.example.yaml files to their real names in a temp dir.
function exampleDir(): { dirs: string[] } {
  const dir = mkdtempSync(path.join(tmpdir(), "digister-ex-"));
  for (const n of ["digister", "interests", "channels"]) {
    copyFileSync(path.resolve("config", `${n}.example.yaml`), path.join(dir, `${n}.yaml`));
  }
  return { dirs: [dir] };
}
const example = exampleDir();
const committed = { dirs: [path.resolve("config")] };

function tmpConfig(files: Record<string, string>): { dirs: string[] } {
  const dir = mkdtempSync(path.join(tmpdir(), "digister-cfg-"));
  for (const [name, body] of Object.entries(files)) writeFileSync(path.join(dir, name), body);
  return { dirs: [dir] };
}

describe("config", () => {
  it("loads the example files", () => {
    const cfg = loadDigisterConfig(example);
    expect(cfg.ollama.chat_model).toBe("qwen3:8b");
    expect(cfg.output_dir.startsWith(homedir())).toBe(true);
    expect(cfg.x.graphql_operations).toContain("ListLatestTweetsTimeline");
    expect(loadInterests(example).topics[0]?.name).toBe("Local AI and agents");
    expect(loadChannels(example).channels).toHaveLength(2);
  });

  it("loads the committed channels.yaml with the two must channels", () => {
    const { channels } = loadChannels(committed);
    expect(channels.map((c) => [c.id, c.tier])).toEqual([
      ["UCswG6FSbgZjbWtdf_hMLaow", "must"],
      ["UCsBjURrPoezykLs9EqgamOA", "must"],
    ]);
  });

  it("rejects a digister.yaml with a missing output_dir, naming file and field", () => {
    const opts = tmpConfig({ "digister.yaml": "ollama:\n  chat_model: x\n" });
    expect(() => loadDigisterConfig(opts)).toThrow(/digister\.yaml.*\n\s+output_dir/);
  });

  it("defaults to brief mode with email off, and needs an address when email is on", () => {
    const cfg = loadDigisterConfig(tmpConfig({ "digister.yaml": 'output_dir: "/tmp/x"\n' }));
    expect(cfg.digest).toMatchObject({ mode: "brief", brief_posts_max: 40, brief_min_score: 5 });
    expect(cfg.email).toMatchObject({ enabled: false, smtp_host: "smtp.gmail.com", smtp_port: 465 });
    expect(loadDigisterConfig(example).email.enabled).toBe(false);
    const on = tmpConfig({ "digister.yaml": 'output_dir: "/tmp/x"\nemail:\n  enabled: true\n' });
    expect(() => loadDigisterConfig(on)).toThrow(/email\.to/);
  });

  it("rejects a channel with an invalid tier", () => {
    const opts = tmpConfig({
      "channels.yaml": 'channels:\n  - id: "UC1"\n    name: "A"\n    tier: urgent\n',
    });
    expect(() => loadChannels(opts)).toThrow(/channels\.yaml.*\n\s+channels\.0\.tier/);
  });

  it("tells the user to copy the example when the file is missing", () => {
    const opts = tmpConfig({});
    expect(() => loadDigisterConfig(opts)).toThrow(/digister\.example\.yaml/);
  });

  it("uses the first directory that has the file", () => {
    const a = tmpConfig({ "interests.yaml": "topics: []\nmute: [a]\n" });
    const b = tmpConfig({ "interests.yaml": "topics: []\nmute: [b]\n" });
    expect(loadInterests({ dirs: [...a.dirs, ...b.dirs] }).mute).toEqual(["a"]);
    const c = tmpConfig({});
    expect(loadInterests({ dirs: [...c.dirs, ...b.dirs] }).mute).toEqual(["b"]);
  });
});
