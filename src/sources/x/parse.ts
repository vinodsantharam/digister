import type { PostInput } from "../../store/db.js";

/** `pinned` marks a profile-pinned tweet: it can be arbitrarily old, so it says nothing about timeline depth. */
export type ParsedPost = PostInput & { pinned?: boolean };

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

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" };
/** `legacy.full_text` arrives HTML-escaped (`&amp;`); note tweet text does not. */
const decodeEntities = (s: string): string => s.replace(/&(?:amp|lt|gt|quot|#39);/g, (m) => ENTITIES[m] ?? m);

/**
 * Tidy tweet text: swap t.co short links for their real address, drop the t.co links that only
 * stand for attached media or the quoted tweet, and remove any unresolved trailing t.co link.
 */
function cleanText(text: string, entities: unknown, quotedId: string | null): string {
  let out = text;
  const list = (k: string): unknown[] => {
    const v = get(entities, k);
    return Array.isArray(v) ? v : [];
  };
  for (const m of list("media")) {
    const u = str(get(m, "url"));
    if (u) out = out.split(u).join("");
  }
  for (const e of list("urls")) {
    const short = str(get(e, "url"));
    const full = str(get(e, "expanded_url"));
    if (!short) continue;
    const isQuoteLink = !!quotedId && !!full && new RegExp(`^https?://(?:www\\.)?(?:x|twitter)\\.com/[^/]+/status/${quotedId}(?:[/?#]|$)`).test(full);
    out = out.split(short).join(isQuoteLink ? "" : full ?? short);
  }
  return out.replace(/\s*https:\/\/t\.co\/\w+\s*$/, "").trim();
}

function toPost(tweet: Obj, source: string | null, quotedId: string | null): ParsedPost | undefined {
  const id = str(tweet.rest_id);
  const legacy = isObj(tweet.legacy) ? tweet.legacy : undefined;
  const { handle, name } = author(tweet);
  const created = xDateToIso(str(legacy?.created_at));
  if (!id || !legacy || !handle || !created) return undefined;

  const quoted = quotedId ?? str(legacy.quoted_status_id_str) ?? null;
  const note = get(tweet, "note_tweet", "note_tweet_results", "result");
  const noteText = str(get(note, "text"));
  const text = noteText
    ? cleanText(noteText, get(note, "entity_set"), quoted)
    : cleanText(decodeEntities(str(legacy.full_text) ?? ""), legacy.entities, quoted);
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
    quoted_id: quoted,
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

  const put = (post: ParsedPost, pinned: boolean): void => {
    const existing = posts.get(post.id);
    if (!existing) posts.set(post.id, pinned ? { ...post, pinned: true } : post);
    else if (existing.pinned && !pinned) posts.set(post.id, post);
  };

  const handleTweet = (node: Obj, source: string | null, pinned: boolean): void => {
    const tweet = unwrap(node);
    if (isObj(tweet.promotedMetadata) || isObj(node.promotedMetadata)) return;

    const rt = get(tweet, "legacy", "retweeted_status_result", "result");
    if (isTweetNode(rt)) {
      const { handle } = author(tweet);
      handleTweet(rt, handle ? `repost by @${handle}` : "repost", pinned);
      return;
    }

    const quoted = get(tweet, "quoted_status_result", "result");
    const quotedId = isTweetNode(quoted) ? str(unwrap(quoted).rest_id) ?? null : null;
    const post = toPost(tweet, source, quotedId);
    if (post) put(post, pinned);
    for (const v of Object.values(tweet)) walk(v, pinned);
  };

  const walk = (node: unknown, pinned = false): void => {
    if (Array.isArray(node)) {
      for (const v of node) walk(v, pinned);
      return;
    }
    if (!isObj(node)) return;
    if (isObj(node.promotedMetadata)) return;
    const entryId = str(node.entryId);
    if (entryId && entryId.startsWith("promoted-")) return;
    const inPin = pinned || node.type === "TimelinePinEntry" || (entryId?.startsWith("pinned-") ?? false);
    if (isTweetNode(node)) {
      handleTweet(node, null, inPin);
      return;
    }
    for (const v of Object.values(node)) walk(v, inPin);
  };

  walk(json);
  return [...posts.values()];
}
