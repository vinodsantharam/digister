import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { isScalar, isSeq, parseDocument } from "yaml";
import { formatChecks, runDoctor, type Check } from "./doctor.js";
import { digisterHome } from "./paths.js";

/** Everything setup says and asks goes through this, so tests can script it. */
export interface SetupIO {
  ask(question: string, defaultValue?: string): Promise<string>;
  say(message: string): void;
}

export interface SetupDeps {
  io: SetupIO;
  platform?: NodeJS.Platform;
  /** Folder holding the repo's example configs and channels.yaml. */
  repoConfigDir?: string;
  doctor?: () => Promise<Check[]>;
}

export interface SetupResult {
  home: string;
  copied: string[];
  outputDir: string;
  listUrl: string | null;
  checks: Check[];
}

const X_LIST_RE = /^https:\/\/(?:x|twitter)\.com\/i\/lists\/\d+\/?$/;
export const isXListUrl = (s: string): boolean => X_LIST_RE.test(s);

export function suggestedOutputDir(platform: NodeJS.Platform = process.platform): string {
  return platform === "darwin"
    ? path.join(homedir(), "Library/Mobile Documents/com~apple~CloudDocs/Digister")
    : path.join(homedir(), "Digister");
}

const defaultRepoConfigDir = (): string => fileURLToPath(new URL("../config/", import.meta.url));

function copyIfMissing(from: string, to: string, copied: string[]): void {
  if (existsSync(to) || !existsSync(from)) return;
  copyFileSync(from, to);
  copied.push(to);
}

/** Set a scalar's value in place so the comment next to it survives. */
function setScalar(doc: ReturnType<typeof parseDocument>, keys: string[], value: string | boolean): void {
  const node = doc.getIn(keys, true);
  if (isScalar(node)) node.value = value;
  else doc.setIn(keys, value);
}

export async function runSetup(deps: SetupDeps): Promise<SetupResult> {
  const { io } = deps;
  const repo = deps.repoConfigDir ?? defaultRepoConfigDir();
  const home = digisterHome();
  const cfgDir = path.join(home, "config");
  mkdirSync(cfgDir, { recursive: true });
  io.say(`Digister home: ${home}`);

  const mainFile = path.join(cfgDir, "digister.yaml");
  const hadMain = existsSync(mainFile);
  const copied: string[] = [];
  copyIfMissing(path.join(repo, "digister.example.yaml"), mainFile, copied);
  copyIfMissing(path.join(repo, "interests.example.yaml"), path.join(cfgDir, "interests.yaml"), copied);
  const channelsFile = path.join(cfgDir, "channels.yaml");
  copyIfMissing(path.join(repo, "channels.yaml"), channelsFile, copied);
  copyIfMissing(path.join(repo, "channels.example.yaml"), channelsFile, copied);
  for (const f of copied) io.say(`Created ${f}`);
  if (copied.length === 0) io.say("Config files already exist; keeping them.");
  if (!existsSync(mainFile)) throw new Error(`No digister.example.yaml found in ${repo}`);

  const doc = parseDocument(readFileSync(mainFile, "utf8"));
  const current = doc.get("output_dir");
  const suggestion = hadMain && typeof current === "string" && current ? current : suggestedOutputDir(deps.platform);

  const outputDir = (await io.ask("Folder that syncs to your phone (iCloud Drive, Dropbox, ...)", suggestion)).trim() || suggestion;
  setScalar(doc, ["output_dir"], outputDir);

  let listUrl: string | null = null;
  for (;;) {
    const answer = (await io.ask("X List address like https://x.com/i/lists/1234567890 (empty to skip X)")).trim();
    if (!answer) break;
    if (isXListUrl(answer)) {
      listUrl = answer;
      break;
    }
    io.say("That does not look like an X List address (https://x.com/i/lists/<digits>). Try again, or press Enter to skip X.");
  }
  if (listUrl) {
    const seq = doc.getIn(["x", "list_urls"], true);
    if (isSeq(seq)) seq.items = [doc.createNode(listUrl)];
    else doc.setIn(["x", "list_urls"], [listUrl]);
    setScalar(doc, ["x", "enabled"], true);
  } else {
    setScalar(doc, ["x", "enabled"], false);
    io.say("Skipping X: x.enabled is false. Re-run `digister setup` later to add a List.");
  }
  let emailTo: string | null = null;
  for (;;) {
    const answer = (await io.ask("Email address to send the digest to (empty to skip email)")).trim();
    if (!answer) break;
    if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(answer)) {
      emailTo = answer;
      break;
    }
    io.say("That does not look like an email address. Try again, or press Enter to skip email.");
  }
  if (emailTo) {
    setScalar(doc, ["email", "to"], emailTo);
    setScalar(doc, ["email", "enabled"], true);
  }

  writeFileSync(mainFile, doc.toString());
  io.say(`Saved ${mainFile}`);

  io.say("\nChecking the setup...");
  const checks = await (deps.doctor ?? (() => runDoctor()))();
  io.say(formatChecks(checks));

  const steps = ["Next steps:"];
  let n = 1;
  if (listUrl) steps.push(`  ${n++}. digister x login      (log in to X once in the browser window)`);
  if (emailTo) {
    steps.push(`  ${n++}. Save your SMTP app password: see "Email to your phone" in the README`);
    steps.push(`  ${n++}. digister email test    (send a test email)`);
  }
  steps.push(`  ${n++}. digister run --dry     (try it without side effects)`);
  steps.push(`  ${n++}. digister run           (write your first digest)`);
  steps.push(`  ${n++}. Install the daily schedule: see "Scheduling" in the README`);
  io.say(steps.join("\n"));
  return { home, copied, outputDir, listUrl, checks };
}

/** Real terminal IO using Node's readline/promises. */
export function terminalIO(): SetupIO & { close(): void } {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return {
    ask: async (q, def) => {
      const a = await rl.question(def ? `${q} [${def}]: ` : `${q}: `);
      return a.trim() || def || "";
    },
    say: (m) => console.log(m),
    close: () => rl.close(),
  };
}
