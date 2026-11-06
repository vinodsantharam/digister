import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatChecks, nodeMajor, runDoctor, writableFolder } from "../src/doctor.js";

const prev = process.env.DIGISTER_HOME;
let home: string;
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "digister-doc-"));
  mkdirSync(path.join(home, "config"), { recursive: true });
  process.env.DIGISTER_HOME = home;
  const cfg = (n: string, body: string) => writeFileSync(path.join(home, "config", `${n}.yaml`), body);
  cfg("digister", `output_dir: "${path.join(home, "out")}"\n`);
  cfg("channels", `channels:\n  - {id: "UC1", name: "A", tier: must}\n`);
  cfg("interests", `topics: []\n`);
});
afterEach(() => {
  if (prev === undefined) delete process.env.DIGISTER_HOME;
  else process.env.DIGISTER_HOME = prev;
});

const healthy = async () => ({ reachable: true, modelPulled: true, ok: true, model: "qwen3:8b", baseUrl: "u" });
const by = (cs: Awaited<ReturnType<typeof runDoctor>>, name: string) => cs.find((c) => c.name === name)!;

describe("runDoctor", () => {
  it("reports a healthy setup", async () => {
    mkdirSync(path.join(home, "x-profile"), { recursive: true });
    writeFileSync(path.join(home, "x-profile", "Local State"), "{}");
    const cs = await runDoctor({ health: healthy, xCheck: async () => "logged_in", scheduleInstalled: () => true });
    expect(cs.filter((c) => c.status !== "ok" && c.name !== "Email")).toEqual([]);
    expect(by(cs, "Email")).toMatchObject({ status: "warn" });
    expect(by(cs, "Channels").detail).toBe("1 channels");
    expect(formatChecks(cs)).toContain("[ok  ] Ollama");
  });

  it("flags problems: old Node, bad config, Ollama down, no X profile, no schedule", async () => {
    writeFileSync(path.join(home, "config", "digister.yaml"), "x: {}\n");
    const cs = await runDoctor({
      nodeVersion: "v20.1.0",
      health: async () => ({ reachable: false, modelPulled: false, ok: false, model: "m", baseUrl: "u", error: "cannot reach Ollama" }),
      scheduleInstalled: () => false,
    });
    expect(by(cs, "Node").status).toBe("fail");
    expect(by(cs, "Config digister.yaml")).toMatchObject({ status: "fail" });
    expect(by(cs, "Config digister.yaml").detail).toContain("output_dir");
    expect(by(cs, "Ollama").status).toBe("fail");
    expect(by(cs, "Schedule").status).toBe("warn");
  });

  it("fails the X check without a profile, and when logged out", async () => {
    const none = await runDoctor({ health: healthy, scheduleInstalled: () => true });
    expect(by(none, "X session").detail).toContain("x login");
    writeFileSync(path.join(home, "x-profile", "f"), "x");
    const out = await runDoctor({ health: healthy, xCheck: async () => "logged_out", scheduleInstalled: () => true });
    expect(by(out, "X session").status).toBe("fail");
  });
});

describe("helpers", () => {
  it("parses node majors and checks writability of the nearest existing parent", () => {
    expect(nodeMajor("v22.4.1")).toBe(22);
    expect(writableFolder(path.join(home, "not", "yet", "there"))).toBe(true);
  });
});
