import type { ChannelsConfig, DigisterConfig, InterestsConfig } from "../config.js";
import type { Post, Video } from "../store/db.js";

export const WORDS_PER_MINUTE = 200;
export const MUST_WATCH_SCORE = 8;
export const ALSO_NEW_MAX = 10;

export interface VideoSelection {
  mustWatch: Video[];
  alsoNew: Video[];
}

export interface PostGroup {
  topic: string;
  posts: Post[];
}

export interface PostSelection {
  groups: PostGroup[];
  count: number;
  readingMinutes: number;
}

const usable = <T extends { score: number | null; shown_in: string | null }>(items: T[]): T[] =>
  items.filter((i) => i.score !== null && i.score > 0 && i.shown_in === null);

/**
 * "Must watch today": up to `mustWatchMax` videos flagged must_watch or scoring >= 8, best
 * first. "Also new": the remaining must/high tier videos, newest first, max 10.
 * Items already shown in an earlier digest are never selected.
 */
export function selectVideos(
  videos: Video[],
  channels: ChannelsConfig,
  digest: Pick<DigisterConfig["digest"], "must_watch_max">,
): VideoSelection {
  const tierOf = new Map(channels.channels.map((c) => [c.id, c.tier] as const));
  const candidates = usable(videos);
  const mustWatch = candidates
    .filter((v) => v.must_watch === 1 || (v.score ?? 0) >= MUST_WATCH_SCORE)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, digest.must_watch_max);
  const picked = new Set(mustWatch.map((v) => v.id));
  const alsoNew = candidates
    .filter((v) => !picked.has(v.id) && ["must", "high"].includes(tierOf.get(v.channel_id) ?? "normal"))
    .sort((a, b) => b.published_at.localeCompare(a.published_at))
    .slice(0, ALSO_NEW_MAX);
  return { mustWatch, alsoNew };
}

const words = (s: string): number => s.split(/\s+/).filter(Boolean).length;

/** Minutes to read a post: its summary plus its original text at 200 words per minute. */
export const readingMinutes = (p: Pick<Post, "summary" | "text">): number =>
  (words(p.summary ?? "") + words(p.text)) / WORDS_PER_MINUTE;

/**
 * Best posts first until `posts_max` or the reading budget is reached, then grouped by topic
 * in the order of interests.yaml ("other" and unknown topics last), best first within a group.
 */
export function selectPosts(
  posts: Post[],
  interests: InterestsConfig,
  digest: Pick<DigisterConfig["digest"], "posts_max" | "reading_minutes">,
): PostSelection {
  const ranked = usable(posts).sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const chosen: Post[] = [];
  let minutes = 0;
  for (const p of ranked) {
    if (chosen.length >= digest.posts_max) break;
    const m = readingMinutes(p);
    if (minutes + m > digest.reading_minutes) break;
    chosen.push(p);
    minutes += m;
  }
  const order = interests.topics.map((t) => t.name);
  const rank = (topic: string | null) => {
    const i = order.indexOf(topic ?? "");
    return i < 0 ? order.length : i;
  };
  const groups = new Map<string, Post[]>();
  for (const p of chosen) {
    const key = rank(p.topic) < order.length ? p.topic! : "other";
    groups.set(key, [...(groups.get(key) ?? []), p]);
  }
  return {
    groups: [...groups.entries()]
      .sort(([a], [b]) => rank(a) - rank(b))
      .map(([topic, ps]) => ({ topic, posts: ps })),
    count: chosen.length,
    readingMinutes: Math.round(minutes),
  };
}
