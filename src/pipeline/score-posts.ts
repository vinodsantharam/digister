import type { InterestsConfig } from "../config.js";
import { getLogger } from "../log.js";
import { generateStructured, type StructuredDeps } from "../llm/client.js";
import { PostScoreBatch } from "../llm/schemas.js";
import { getPost, setPostScore, setPostText, unscoredPosts, type Db, type Post } from "../store/db.js";
import { chunk, interestsBlock, isMuted } from "./common.js";

export const POST_BATCH_SIZE = 15;
export const POST_TEXT_MAX = 1000;

export interface ScorePostsOptions {
  interests: InterestsConfig;
  sinceIso: string;
  llm?: StructuredDeps;
}

export interface ScorePostsResult {
  scored: number;
  muted: number;
  repliesDropped: number;
  /** Posts folded into the first post of their self-thread. */
  merged: number;
  unscored: number;
  batches: number;
}

const SYSTEM =
  "Score how worth reading each post is for this person today, 0 to 10. Reward original insight, news, and useful links in their interests. Penalize hot takes, engagement bait, and memes. Write a neutral one- or two-sentence summary (max 200 characters). Set topic to exactly one of the interest names, or \"other\". Return every post id you were given.";

const domains = (linksJson: string): string[] => {
  try {
    const urls = JSON.parse(linksJson) as unknown;
    if (!Array.isArray(urls)) return [];
    return [...new Set(urls.flatMap((u) => { try { return [new URL(String(u)).hostname]; } catch { return []; } }))];
  } catch {
    return [];
  }
};

/** A reply is part of a thread only when its parent is the same author's post. */
function isReplyToOthers(db: Db, p: Post): boolean {
  if (!p.reply_to_id) return false;
  const parent = getPost(db, p.reply_to_id);
  return !(parent && parent.author_handle === p.author_handle);
}

interface Item {
  head: Post;
  members: Post[];
  text: string;
}

/**
 * Score unscored posts: drop muted posts and replies to other people, merge self-threads
 * (same conversation, same author) into one item, then score in batches of 15.
 * Dropped and merged-away posts get score 0 so they are never picked.
 */
export async function scorePosts(db: Db, opts: ScorePostsOptions): Promise<ScorePostsResult> {
  const log = getLogger();
  const result: ScorePostsResult = { scored: 0, muted: 0, repliesDropped: 0, merged: 0, unscored: 0, batches: 0 };
  const topics = new Set(opts.interests.topics.map((t) => t.name));

  const kept: Post[] = [];
  for (const p of unscoredPosts(db, opts.sinceIso)) {
    if (isMuted(p.text, opts.interests.mute)) {
      setPostScore(db, p.id, 0, "other", "muted");
      result.muted++;
    } else if (isReplyToOthers(db, p)) {
      setPostScore(db, p.id, 0, "other", "reply to someone else");
      result.repliesDropped++;
    } else {
      kept.push(p);
    }
  }

  const groups = new Map<string, Post[]>();
  for (const p of kept) {
    const key = p.conversation_id ? `${p.conversation_id}|${p.author_handle}` : `solo|${p.id}`;
    groups.set(key, [...(groups.get(key) ?? []), p]);
  }
  const items: Item[] = [...groups.values()].map((members) => {
    members.sort((a, b) => a.created_at.localeCompare(b.created_at));
    return { head: members[0]!, members, text: members.map((m) => m.text).join("\n\n") };
  });
  items.sort((a, b) => b.head.created_at.localeCompare(a.head.created_at));

  const interests = interestsBlock(opts.interests);
  for (const batch of chunk(items, POST_BATCH_SIZE)) {
    result.batches++;
    const body = batch
      .map((it) =>
        [
          `id: ${it.head.id}`,
          `author: ${it.head.author_name} (@${it.head.author_handle})`,
          it.members.length > 1 ? `thread of ${it.members.length} posts` : null,
          `text: ${it.text.slice(0, POST_TEXT_MAX)}`,
          `link domains: ${domains(it.head.links_json).join(", ") || "none"}`,
          `likes: ${it.head.like_count}, reposts: ${it.head.repost_count}`,
        ]
          .filter(Boolean)
          .join("\n"),
      )
      .join("\n\n");
    try {
      const out = await generateStructured(
        PostScoreBatch,
        SYSTEM,
        `The person's interests:\n${interests}\n\nPosts:\n\n${body}`,
        opts.llm,
      );
      const byId = new Map(batch.map((it) => [it.head.id, it] as const));
      for (const s of out.items) {
        const it = byId.get(s.id);
        if (!it) continue;
        byId.delete(s.id);
        const topic = topics.has(s.topic) ? s.topic : "other";
        if (it.members.length > 1) setPostText(db, it.head.id, it.text);
        setPostScore(db, it.head.id, s.score, topic, s.summary);
        for (const m of it.members.slice(1)) {
          setPostScore(db, m.id, 0, "other", `merged into thread ${it.head.id}`);
          result.merged++;
        }
        result.scored++;
      }
      result.unscored += byId.size;
    } catch (err) {
      log.warn({ err: (err as Error).message }, "post scoring batch failed; posts stay unscored");
      result.unscored += batch.length;
    }
  }
  return result;
}
