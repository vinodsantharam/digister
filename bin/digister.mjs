#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const tsxCli = require.resolve("tsx/cli");
const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const r = spawnSync(process.execPath, [tsxCli, cli, ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(r.status ?? 1);
