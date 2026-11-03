import type { PostInput } from "../../store/db.js";

export type ParsedPost = PostInput;

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const get = (o: unknown, ...keys: string[]): unknown => {
  let cur = o;
  for (const k of keys) {
    if (!isObj(cur)) return undefined;
    cur = cur[k];
  }
  return cur;
};

/** `Wed Oct 30 05:30:00 +0000 2026` -> ISO 8601, or undefined if unparseable. */
export function xDateToIso(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

/** TweetWithVisibilityResults wraps the real tweet in `.tweet`. */
function unwrap(node: Obj): Obj {
  if (node.__typename === "TweetWithVisibilityResults" && isObj(node.tweet)) return node.tweet;
  return node;
}

const isTweetNode = (v: unknown): v is Obj =>
  isObj(v) && (v.__typename === "Tweet" || v.__typename === "TweetWithVisibilityResults");

function author(tweet: Obj): { handle?: string; name?: string } {
  const user = get(tweet, "core", "user_results", "result");
  return {
    handle: str(get(user, "core", "screen_name")) ?? str(get(user, "legacy", "screen_name")),
    name: str(get(user, "core", "name")) ?? str(get(user, "legacy", "name")),
  };
}

function toPost(tweet: Obj, source: string | null, quotedId: string | null): ParsedPost | undefined {
  const id = str(tweet.rest_id);
  const legacy = isObj(tweet.legacy) ? tweet.legacy : undefined;
  const { handle, name } = author(tweet);
  const created = xDateToIso(str(legacy?.created_at));
  if (!id || !legacy || !handle || !created) return undefined;

  const text = str(get(tweet, "note_tweet", "note_tweet_results", "result", "text")) ?? str(legacy.full_text) ?? "";
  const urls = get(legacy, "entities", "urls");
  const links = Array.isArray(urls)
    ? urls.map((u) => str(get(u, "expanded_url"))).filter((u): u is string => !!u)
    : [];
  const mediaRaw = get(legacy, "extended_entities", "media");
  const media = Array.isArray(mediaRaw)
    ? mediaRaw
        .map((m) => ({ type: str(get(m, "type")), url: str(get(m, "media_url_https")) ?? str(get(m, "expanded_url")) }))
        .filter((m) => m.type && m.url)
    : [];

  return {
    id,
    author_handle: handle,
    author_name: name ?? handle,
    text,
    url: `https://x.com/${handle}/status/${id}`,
    created_at: created,
    lang: str(legacy.lang) ?? null,
    reply_to_id: str(legacy.in_reply_to_status_id_str) ?? null,
    quoted_id: quotedId ?? str(legacy.quoted_status_id_str) ?? null,
    conversation_id: str(legacy.conversation_id_str) ?? null,
    like_count: num(legacy.favorite_count),
    repost_count: num(legacy.retweet_count),
    media_json: JSON.stringify(media),
    links_json: JSON.stringify(links),
    source,
  };
}

/**
 * Parse a captured X GraphQL timeline payload into posts. Walks the whole JSON rather than
 * following one fixed path, so it survives X reshuffling the envelope. Pure.
 */
export function parseTimeline(json: unknown): ParsedPost[] {
  const posts = new Map<string, ParsedPost>();

  const handleTweet = (node: Obj, source: string | null): void => {
    const tweet = unwrap(node);
    if (isObj(tweet.promotedMetadata) || isObj(node.promotedMetadata)) return;

    const rt = get(tweet, "legacy", "retweeted_status_result", "result");
    if (isTweetNode(rt)) {
      const { handle } = author(tweet);
      handleTweet(rt, handle ? `repost by @${handle}` : "repost");
      return;
    }

    const quoted = get(tweet, "quoted_status_result", "result");
    const quotedId = isTweetNode(quoted) ? str(unwrap(quoted).rest_id) ?? null : null;
    const post = toPost(tweet, source, quotedId);
    if (post && !posts.has(post.id)) posts.set(post.id, post);
    for (const v of Object.values(tweet)) walk(v);
  };

  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const v of node) walk(v);
      return;
    }
    if (!isObj(node)) return;
    if (isObj(node.promotedMetadata)) return;
    const entryId = str(node.entryId);
    if (entryId && entryId.startsWith("promoted-")) return;
    if (isTweetNode(node)) {
      handleTweet(node, null);
      return;
    }
    for (const v of Object.values(node)) walk(v);
  };

  walk(json);
  return [...posts.values()];
}
