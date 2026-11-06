import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { loadChannels, loadDigisterConfig, loadInterests, type DigisterConfig } from "./config.js";
import { ollamaHealthy, type OllamaStatus } from "./llm/client.js";
import { getPaths } from "./paths.js";
import { verifyEmail } from "./deliver/email.js";
import { xCheck } from "./sources/x/browser.js";

export type CheckStatus = "ok" | "warn" | "fail";
export interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface DoctorDeps {
  nodeVersion?: string;
  platform?: NodeJS.Platform;
  health?: () => Promise<OllamaStatus>;
  xCheck?: (o: { headless: boolean }) => Promise<"logged_in" | "logged_out" | "blocked">;
  /** Password readable and SMTP login accepted; throws otherwise. */
  verifyEmail?: (cfg: DigisterConfig["email"]) => Promise<void>;
  /** Exit status of the OS schedule query; true when the schedule is installed. */
  scheduleInstalled?: (platform: NodeJS.Platform) => boolean;
}

export function nodeMajor(version: string): number {
  return Number.parseInt(version.replace(/^v/, ""), 10);
}

/** Walk up to the nearest existing folder and test that it is writable (does not create anything). */
export function writableFolder(dir: string): boolean {
  let cur = path.resolve(dir);
  while (!existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) return false;
    cur = parent;
  }
  try {
    accessSync(cur, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function defaultScheduleInstalled(platform: NodeJS.Platform): boolean {
  if (platform === "darwin") return existsSync(path.join(homedir(), "Library/LaunchAgents/com.digister.run.plist"));
  if (platform === "linux") return spawnSync("systemctl", ["--user", "is-enabled", "digister.timer"], { stdio: "ignore" }).status === 0;
  if (platform === "win32") return spawnSync("schtasks", ["/Query", "/TN", "Digister"], { stdio: "ignore" }).status === 0;
  return false;
}

const hasFiles = (dir: string): boolean => existsSync(dir) && readdirSync(dir).length > 0;

/** Run every setup check. Never throws; each problem becomes a check with an explanation. */
export async function runDoctor(deps: DoctorDeps = {}): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (name: string, status: CheckStatus, detail: string) => checks.push({ name, status, detail });

  const nodeV = deps.nodeVersion ?? process.version;
  add("Node", nodeMajor(nodeV) >= 22 ? "ok" : "fail", nodeMajor(nodeV) >= 22 ? nodeV : `${nodeV}; Digister needs Node 22 or newer`);

  let cfg: DigisterConfig | undefined;
  let channelCount = 0;
  const tryLoad = <T>(name: string, load: () => T): T | undefined => {
    try {
      const v = load();
      add(`Config ${name}.yaml`, "ok", "valid");
      return v;
    } catch (err) {
      add(`Config ${name}.yaml`, "fail", (err as Error).message);
      return undefined;
    }
  };
  cfg = tryLoad("digister", () => loadDigisterConfig());
  const channels = tryLoad("channels", () => loadChannels());
  tryLoad("interests", () => loadInterests());
  if (channels) channelCount = channels.channels.length;
  add("Channels", channelCount > 0 ? "ok" : channels ? "warn" : "fail", channels ? `${channelCount} channels` : "channels.yaml not loaded");

  const s = await (deps.health ?? (() => ollamaHealthy()))().catch(
    (err: Error) => ({ ok: false, model: "?", error: err.message }) as Pick<OllamaStatus, "ok" | "model" | "error">,
  );
  add("Ollama", s.ok ? "ok" : "fail", s.ok ? `reachable, model ${s.model} pulled` : (s.error ?? "not ready"));

  if (cfg) {
    const ok = writableFolder(cfg.output_dir);
    add("Output folder", ok ? "ok" : "fail", ok ? cfg.output_dir : `${cfg.output_dir} is not writable`);

    if (!cfg.x.enabled) add("X session", "warn", "X is disabled in digister.yaml");
    else if (!hasFiles(getPaths().xProfile)) add("X session", "fail", "no X profile yet; run `digister x login` or `digister x import-cookies`");
    else {
      try {
        const state = await (deps.xCheck ?? xCheck)({ headless: cfg.x.headless });
        add(
          "X session",
          state === "logged_in" ? "ok" : "fail",
          state === "logged_in" ? "logged in" : state === "logged_out" ? "logged out; run `digister x login` or `digister x import-cookies`" : "blocked (challenge page or HTTP error); open the profile headed and resolve it",
        );
      } catch (err) {
        add("X session", "fail", (err as Error).message);
      }
    }
  }

  if (cfg) {
    if (!cfg.email.enabled) add("Email", "warn", "email is off (email.enabled in digister.yaml)");
    else {
      try {
        await (deps.verifyEmail ?? verifyEmail)(cfg.email);
        add("Email", "ok", `SMTP login works; digests go to ${cfg.email.to}`);
      } catch (err) {
        add("Email", "fail", (err as Error).message);
      }
    }
  }

  const platform = deps.platform ?? process.platform;
  const installed = (deps.scheduleInstalled ?? defaultScheduleInstalled)(platform);
  add("Schedule", installed ? "ok" : "warn", installed ? "daily job installed" : "not installed (see the README, scheduling)");
  return checks;
}

export function formatChecks(checks: Check[]): string {
  const mark = { ok: "ok  ", warn: "warn", fail: "FAIL" } as const;
  return checks.map((c) => `[${mark[c.status]}] ${c.name}: ${c.detail}`).join("\n");
}
