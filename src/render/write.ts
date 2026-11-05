import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

function writeAtomic(file: string, html: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, html, "utf8");
  renameSync(tmp, file);
}

/**
 * Write digest-YYYY-MM-DD.html into `outputDir` atomically and refresh latest.html. A second
 * run on the same day goes to digest-YYYY-MM-DD-2.html so the earlier digest is never lost.
 */
export function writeDigest(html: string, outputDir: string, date: string): string {
  mkdirSync(outputDir, { recursive: true });
  let file = path.join(outputDir, `digest-${date}.html`);
  for (let n = 2; existsSync(file); n++) file = path.join(outputDir, `digest-${date}-${n}.html`);
  writeAtomic(file, html);
  writeAtomic(path.join(outputDir, "latest.html"), html);
  return file;
}
