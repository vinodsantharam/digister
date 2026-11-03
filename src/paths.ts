import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return path.join(homedir(), p.slice(2));
  return p;
}

export function digisterHome(): string {
  const env = process.env.DIGISTER_HOME;
  return path.resolve(expandHome(env && env.length > 0 ? env : "~/.digister"));
}

export interface Paths {
  home: string;
  db: string;
  xProfile: string;
  logs: string;
  raw: string;
  config: string;
}

/** Resolve all paths and create the directories (not the db file) if missing. */
export function getPaths(): Paths {
  const home = digisterHome();
  const paths: Paths = {
    home,
    db: path.join(home, "digister.db"),
    xProfile: path.join(home, "x-profile"),
    logs: path.join(home, "logs"),
    raw: path.join(home, "raw"),
    config: path.join(home, "config"),
  };
  for (const dir of [paths.home, paths.xProfile, paths.logs, paths.raw]) {
    mkdirSync(dir, { recursive: true });
  }
  return paths;
}
