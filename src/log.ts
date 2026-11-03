import path from "node:path";
import pino from "pino";
import { getPaths } from "./paths.js";

let logger: pino.Logger | undefined;

export function getLogger(): pino.Logger {
  if (!logger) {
    const date = new Date().toISOString().slice(0, 10);
    const file = path.join(getPaths().logs, `digister-${date}.log`);
    logger = pino(
      { level: process.env.DIGISTER_LOG_LEVEL ?? "info" },
      pino.multistream([
        { stream: process.stdout },
        { stream: pino.destination({ dest: file, mkdir: true, sync: true }) },
      ]),
    );
  }
  return logger;
}
