import type { InterestsConfig } from "../config.js";
import { getLogger } from "../log.js";
import { generateStructured, type StructuredDeps } from "../llm/client.js";
import { Brief } from "../llm/schemas.js";
import type { Post } from "../store/db.js";
import { interestsBlock } from "./common.js";

export const BRIEF_TIMEOUT_MS = 300_000;
const TEXT_MAX = 300;

export interface Story {
  topic: string;
  title: string;
  body: string;
  sources: Post[];
}

export interface DigestBrief {
  headlines: string[];
  stories: Story[];
  /** Posts sent to the model that no story covers; shown as one-line links. */
  leftovers: Post[];
}

const SYSTEM = [
  "You write a short morning briefing from posts this person follows on X.",
  "Step 1, group: posts that mention the same product, model, release, company or event belong to ONE story, even when they add different details (for example a release, its benchmarks and a tool adding support for it are one story). Never write two stories about the same subject.",
  "Step 2, write: each story gets a plain title (max 90 characters) and a neutral body of 2 or 3 sentences (max 450 characters) that combines the details from all its posts. Name people as @handle.",
  "Step 3, headlines: 3 to 5 one-line bullets (max 140 characters each), one per story, for the most important stories for this person's interests, most important first. Each headline is about a different story.",
  "Set each story's topic to exactly one of the interest names, or \"other\". List the ids of all the posts each story is based on, using only ids you were given.",
  "No hype, no emojis, no opinions of your own. Leave out posts that are not worth a story.",
].join(" ");

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

export function briefPrompt(posts: Post[], interests: InterestsConfig): string {
  const body = posts
    .map((p) =>
      [
        `id: ${p.id}`,
        `author: @${p.author_handle}`,
        `topic: ${p.topic ?? "other"}`,
        `score: ${p.score ?? 0}`,
        `summary: ${oneLine(p.summary ?? "")}`,
        `text: ${oneLine(p.text).slice(0, TEXT_MAX)}`,
      ].join("\n"),
    )
    .join("\n\n");
  return `The person's interests:\n${interestsBlock(interests)}\n\nPosts, best first:\n\n${body}`;
}

/**
 * Pure: turn the model's answer into a brief the page can trust. Unknown ids are dropped,
 * each post belongs to one story only, stories with no posts left are dropped, unknown topics
 * become "other", and stories are ordered by interests.yaml topic order, then by best post score.
 */
export function normalizeBrief(raw: Brief, posts: Post[], interests: InterestsConfig): DigestBrief {
  const byId = new Map(posts.map((p) => [p.id, p] as const));
  const used = new Set<string>();
  const order = interests.topics.map((t) => t.name);
  const rank = (topic: string) => {
    const i = order.indexOf(topic);
    return i < 0 ? order.length : i;
  };
  const stories: Story[] = [];
  for (const s of raw.stories) {
    const sources: Post[] = [];
    for (const id of s.post_ids) {
      const p = byId.get(id);
      if (!p || used.has(id)) continue;
      used.add(id);
      sources.push(p);
    }
    if (!sources.length || !s.title.trim()) continue;
    stories.push({
      topic: order.includes(s.topic) ? s.topic : "other",
      title: s.title.trim(),
      body: s.body.trim(),
      sources,
    });
  }
  const best = (s: Story) => Math.max(...s.sources.map((p) => p.score ?? 0));
  stories.sort((a, b) => rank(a.topic) - rank(b.topic) || best(b) - best(a));
  return {
    // One headline per story at most: small models tend to repeat a story as extra headlines.
    headlines: [...new Set(raw.headlines.map((h) => h.trim()).filter(Boolean))].slice(0, Math.max(1, stories.length)),
    stories,
    leftovers: posts.filter((p) => !used.has(p.id)),
  };
}

/** One model call over the selected posts. Returns null when there are no posts or the model fails. */
export async function buildBrief(
  posts: Post[],
  interests: InterestsConfig,
  llm: StructuredDeps = {},
): Promise<DigestBrief | null> {
  if (!posts.length) return null;
  try {
    const raw = await generateStructured(Brief, SYSTEM, briefPrompt(posts, interests), {
      ...llm,
      timeoutMs: llm.timeoutMs ?? BRIEF_TIMEOUT_MS,
    });
    const brief = normalizeBrief(raw, posts, interests);
    return brief.stories.length ? brief : null;
  } catch (err) {
    getLogger().warn({ err: (err as Error).message }, "brief generation failed");
    return null;
  }
}
