import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

function writeAtomic(file: string, html: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, html, "utf8");
  renameSync(tmp, file);
}

/** Write digest-YYYY-MM-DD.html into `outputDir` atomically and refresh latest.html. */
export function writeDigest(html: string, outputDir: string, date: string): string {
  mkdirSync(outputDir, { recursive: true });
  const file = path.join(outputDir, `digest-${date}.html`);
  writeAtomic(file, html);
  writeAtomic(path.join(outputDir, "latest.html"), html);
  return file;
}
