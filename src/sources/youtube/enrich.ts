import { z } from "zod";
import { getLogger } from "../../log.js";
import { setVideoEnrichment, videoIdsWithoutDuration, type Db } from "../../store/db.js";
import type { FetchFn } from "./channels.js";

const API_URL = "https://www.googleapis.com/youtube/v3/videos";
const BATCH = 50;
const TIMEOUT_MS = 15_000;
const SHORT_MAX_S = 180;

/** Parse an ISO 8601 duration such as PT1H2M3S or P1DT2H to seconds. Returns null if invalid. */
export function parseIsoDuration(iso: string): number | null {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(iso);
  if (!m || iso === "P" || iso.endsWith("T")) return null;
  const [d, h, min, s] = m.slice(1).map((x) => Number(x ?? 0)) as [number, number, number, number];
  return d * 86400 + h * 3600 + min * 60 + s;
}

const ResponseSchema = z.object({
  items: z
    .array(
      z.object({
        id: z.string(),
        contentDetails: z.object({ duration: z.string() }),
        statistics: z.object({ viewCount: z.string().optional() }).optional(),
      }),
    )
    .default([]),
});

export interface Enrichment {
  id: string;
  duration_s: number;
  view_count: number | null;
}

/** Parse a videos.list response body into enrichment records (invalid items are dropped). */
export function parseVideosResponse(json: unknown): Enrichment[] {
  const out: Enrichment[] = [];
  for (const item of ResponseSchema.parse(json).items) {
    const duration_s = parseIsoDuration(item.contentDetails.duration);
    if (duration_s === null) continue;
    const views = item.statistics?.viewCount;
    out.push({ id: item.id, duration_s, view_count: views !== undefined ? Number(views) : null });
  }
  return out;
}

export interface EnrichOptions {
  apiKey: string;
  /** Defaults to every stored video without a duration. */
  ids?: string[];
  fetchFn?: FetchFn;
}

/**
 * Optional enrichment through the free YouTube Data API key. Does nothing without a key.
 * Any API error is logged (never with the key) and enrichment stops without failing the run.
 */
export async function enrichVideos(db: Db, opts: EnrichOptions): Promise<number> {
  if (!opts.apiKey) return 0;
  const log = getLogger();
  const fetchFn = opts.fetchFn ?? fetch;
  const ids = opts.ids ?? videoIdsWithoutDuration(db);
  let updated = 0;
  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = ids.slice(i, i + BATCH);
    const params = new URLSearchParams({
      part: "contentDetails,statistics",
      id: batch.join(","),
      key: opts.apiKey,
    });
    try {
      const res = await fetchFn(`${API_URL}?${params}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      for (const e of parseVideosResponse(await res.json())) {
        setVideoEnrichment(db, e.id, { ...e, is_short: e.duration_s <= SHORT_MAX_S });
        updated++;
      }
    } catch (err) {
      log.warn({ err: (err as Error).message }, "youtube enrichment failed, continuing without it");
      return updated;
    }
  }
  return updated;
}
