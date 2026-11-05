import { XMLParser } from "fast-xml-parser";
import { z } from "zod";
import { getLogger } from "../../log.js";
import { upsertVideo, type Db, type VideoInput } from "../../store/db.js";
import { UA, type FetchFn } from "./channels.js";

const FEED_URL = "https://www.youtube.com/feeds/videos.xml?channel_id=";
const TIMEOUT_MS = 15_000;
const CONCURRENCY = 4;

const text = z.union([z.string(), z.number()]).transform(String);
const EntrySchema = z.object({
  "yt:videoId": text,
  title: text,
  published: text,
  link: z.union([
    z.object({ "@_href": z.string() }),
    z.array(z.object({ "@_href": z.string(), "@_rel": z.string().optional() })),
  ]),
  author: z.object({ name: text }).optional(),
  "media:group": z
    .object({
      "media:description": text.optional(),
      "media:thumbnail": z.object({ "@_url": z.string() }).optional(),
    })
    .optional(),
});
const FeedSchema = z.object({
  feed: z.object({ entry: z.array(EntrySchema).default([]) }),
});

export interface FeedEntry {
  id: string;
  title: string;
  published_at: string;
  author: string | null;
  description: string;
  thumbnail_url: string | null;
  url: string;
  is_short: 1 | null;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: false,
  isArray: (name) => name === "entry",
});

/** Parse a YouTube channel Atom feed. Throws if the payload is not a feed. */
export function parseFeed(xml: string): FeedEntry[] {
  const { feed } = FeedSchema.parse(parser.parse(xml));
  return feed.entry.map((e) => {
    const links = Array.isArray(e.link) ? e.link : [e.link];
    const url = (links.find((l) => "@_rel" in l && l["@_rel"] === "alternate") ?? links[0]!)["@_href"];
    const group = e["media:group"];
    return {
      id: e["yt:videoId"],
      title: e.title,
      published_at: new Date(e.published).toISOString(),
      author: e.author?.name ?? null,
      description: group?.["media:description"] ?? "",
      thumbnail_url: group?.["media:thumbnail"]?.["@_url"] ?? null,
      url,
      // Heuristic only: a /shorts/ link is a Short; anything else stays unknown.
      is_short: url.includes("/shorts/") ? 1 : null,
    };
  });
}

export interface RssChannel {
  id: string;
  name: string;
}

async function getFeedXml(channelId: string, fetchFn: FetchFn): Promise<string> {
  const url = FEED_URL + encodeURIComponent(channelId);
  const attempt = async () => {
    const res = await fetchFn(url, {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new HttpError(`GET ${url}: HTTP ${res.status}`);
    return res.text();
  };
  try {
    return await attempt();
  } catch (err) {
    if (err instanceof HttpError) throw err; // retry network errors only
    return attempt();
  }
}

class HttpError extends Error {}

export interface FetchedFeed {
  channel: RssChannel;
  entries: FeedEntry[];
}

/** Fetch and parse one channel's feed (15 s timeout, one retry on network error). */
export async function fetchChannelFeed(channel: RssChannel, fetchFn: FetchFn = fetch): Promise<FeedEntry[]> {
  return parseFeed(await getFeedXml(channel.id, fetchFn));
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Fetch feeds for all channels, at most 4 at a time. A failing channel is logged and skipped. */
export async function fetchAllFeeds(
  channels: RssChannel[],
  fetchFn: FetchFn = fetch,
): Promise<{ feeds: FetchedFeed[]; failed: string[] }> {
  const log = getLogger();
  const failed: string[] = [];
  const results = await mapLimit(channels, CONCURRENCY, async (channel) => {
    try {
      return { channel, entries: await fetchChannelFeed(channel, fetchFn) };
    } catch (err) {
      log.warn({ channel: channel.id, err: (err as Error).message }, "youtube feed failed, skipping");
      failed.push(channel.name);
      return null;
    }
  });
  return { feeds: results.filter((r): r is FetchedFeed => r !== null), failed };
}

export interface CollectOptions {
  lookbackHours: number;
  fetchFn?: FetchFn;
  now?: Date;
}

/** Collect recent videos for all channels into the db. Returns how many were within the window. */
export async function collectVideos(
  db: Db,
  channels: RssChannel[],
  opts: CollectOptions,
): Promise<{ videos: number; failed: string[] }> {
  const cutoff = (opts.now ?? new Date()).getTime() - opts.lookbackHours * 3_600_000;
  const { feeds, failed } = await fetchAllFeeds(channels, opts.fetchFn);
  let videos = 0;
  for (const { channel, entries } of feeds) {
    for (const e of entries) {
      if (new Date(e.published_at).getTime() < cutoff) continue;
      const v: VideoInput = {
        id: e.id,
        channel_id: channel.id,
        channel_name: channel.name,
        title: e.title,
        description: e.description,
        url: e.url,
        thumbnail_url: e.thumbnail_url,
        published_at: e.published_at,
        is_short: e.is_short,
      };
      upsertVideo(db, v);
      videos++;
    }
  }
  return { videos, failed };
}
