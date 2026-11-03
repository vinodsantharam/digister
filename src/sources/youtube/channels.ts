import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isMap, isSeq, parseDocument, YAMLMap } from "yaml";
import { findConfigFile, type Tier } from "../../config.js";
import { digisterHome } from "../../paths.js";

export interface ChannelRef {
  id: string;
  name: string;
}

export type FetchFn = typeof fetch;

const CHANNEL_ID_RE = /^UC[\w-]{22}$/;
export const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

/** Minimal RFC 4180 CSV parser (quoted fields, doubled quotes, CRLF). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== "")) rows.push(row);
  return rows;
}

/** Parse a Google Takeout subscriptions.csv (Channel Id, Channel Url, Channel Title). */
export function parseTakeoutCsv(text: string): ChannelRef[] {
  const [header, ...rows] = parseCsv(text);
  if (!header) return [];
  const col = (name: string) => header.findIndex((h) => h.trim().toLowerCase() === name);
  const idCol = col("channel id");
  const titleCol = col("channel title");
  if (idCol < 0) throw new Error('Takeout CSV has no "Channel Id" column');
  const out: ChannelRef[] = [];
  for (const r of rows) {
    const id = r[idCol]?.trim() ?? "";
    if (!CHANNEL_ID_RE.test(id)) continue;
    out.push({ id, name: (titleCol >= 0 ? r[titleCol]?.trim() : "") || id });
  }
  return out;
}

const decodeEntities = (s: string) =>
  s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

/** Read the channel id and name from a channel page's HTML. Returns null if no id is found. */
export function extractChannel(html: string): ChannelRef | null {
  const id =
    html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["'][^"']*\/channel\/(UC[\w-]{22})["']/)?.[1] ??
    html.match(/<link[^>]+href=["'][^"']*\/channel\/(UC[\w-]{22})["'][^>]+rel=["']canonical["']/)?.[1] ??
    html.match(/"channelId":"(UC[\w-]{22})"/)?.[1] ??
    html.match(/"externalId":"(UC[\w-]{22})"/)?.[1];
  if (!id) return null;
  const title =
    html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)["']/)?.[1] ??
    html.match(/<title>([^<]*?)(?: - YouTube)?<\/title>/)?.[1];
  return { id, name: title ? decodeEntities(title).trim() : id };
}

/** Turn "@handle", a bare handle or a URL into a fetchable channel page URL. */
export function channelPageUrl(input: string): string {
  const s = input.trim();
  if (/^https?:\/\//.test(s)) return s;
  if (CHANNEL_ID_RE.test(s)) return `https://www.youtube.com/channel/${s}`;
  return `https://www.youtube.com/${s.startsWith("@") ? s : `@${s}`}`;
}

/** Resolve one channel from a URL or @handle by fetching its page. */
export async function resolveChannel(
  input: string,
  fetchFn: FetchFn = fetch,
): Promise<ChannelRef> {
  const url = channelPageUrl(input);
  const res = await fetchFn(url, {
    headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`GET ${url} failed: HTTP ${res.status}`);
  const channel = extractChannel(await res.text());
  if (!channel) throw new Error(`Could not find a channel id on ${url}`);
  return channel;
}

/** Where channels.yaml should be read from / written to. */
export function channelsFilePath(): string {
  return findConfigFile("channels") ?? path.join(digisterHome(), "config", "channels.yaml");
}

/**
 * Append channels not yet present (by id) to channels.yaml, preserving comments.
 * Never removes or re-tiers existing entries. Returns the channels actually added.
 */
export function addChannels(file: string, channels: ChannelRef[], tier: Tier): ChannelRef[] {
  const doc = parseDocument(existsSync(file) ? readFileSync(file, "utf8") : "channels: []\n");
  let seq = doc.get("channels", true);
  if (!isSeq(seq)) {
    seq = doc.createNode([]);
    doc.set("channels", seq);
  }
  if (!isSeq(seq)) throw new Error(`${file}: "channels" must be a list`);
  const known = new Set(
    seq.items.map((i) => (isMap(i) ? String(i.get("id")) : "")).filter(Boolean),
  );
  const added: ChannelRef[] = [];
  for (const c of channels) {
    if (known.has(c.id)) continue;
    known.add(c.id);
    const item = new YAMLMap();
    item.set("id", c.id);
    item.set("name", c.name);
    item.set("tier", tier);
    seq.add(item);
    added.push(c);
  }
  if (added.length > 0) {
    seq.flow = false;
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, doc.toString());
  }
  return added;
}

export interface ImportOptions {
  takeout?: string;
  url?: string;
  tier: Tier;
  file?: string;
  fetchFn?: FetchFn;
}

/** Implements `digister youtube import`. Returns the added and the already-known counts. */
export async function importChannels(opts: ImportOptions): Promise<{ added: ChannelRef[]; skipped: number; file: string }> {
  if (!opts.takeout === !opts.url) throw new Error("Give exactly one of --takeout <csv> or --url <channel>");
  const file = opts.file ?? channelsFilePath();
  const found = opts.takeout
    ? parseTakeoutCsv(readFileSync(opts.takeout, "utf8"))
    : [await resolveChannel(opts.url!, opts.fetchFn)];
  // Takeout imports are always tier normal; --tier applies to --url.
  const added = addChannels(file, found, opts.takeout ? "normal" : opts.tier);
  return { added, skipped: found.length - added.length, file };
}
