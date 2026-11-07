import type { InterestsConfig } from "../config.js";
import { getLogger } from "../log.js";
import { generateStructured, type StructuredDeps } from "../llm/client.js";
import { Clusters, Headlines, StoryText } from "../llm/schemas.js";
import type { Post } from "../store/db.js";
import { interestsBlock } from "./common.js";

/**
 * The morning brief is built in three passes, each a small task a local model does well:
 *   1. cluster: one call over every post (id + one-line summary) that returns groups of ids
 *      about the same specific thing. Code makes sure every post ends up in exactly one group.
 *   2. write: one call per group worth a story, reading the full post texts.
 *   3. headlines: one call over the top stories.
 * Single posts become quick hits from the summary scoring already wrote, with no extra call.
 * Each pass falls back on its own when the model fails.
 */

export const CLUSTER_TIMEOUT_MS = 300_000;
export const STORY_TIMEOUT_MS = 120_000;
/** A post with no other post about the same thing still gets a story at this score or above. */
export const SOLO_STORY_SCORE = 8;
export const HEADLINES_MAX = 5;
const STORY_TEXT_MAX = 600;

export interface Story {
  topic: string;
  title: string;
  body: string;
  sources: Post[];
}

export interface QuickHit {
  line: string;
  post: Post;
}

export interface DigestBrief {
  headlines: string[];
  stories: Story[];
  /** Minor posts, one line each, best score first. */
  quickHits: QuickHit[];
  /** Posts over the story and quick-hit limits, best score first; the page shows only a few. */
  leftovers: Post[];
}

export interface BriefLimits {
  storiesMax: number;
  quickHitsMax: number;
}

export const DEFAULT_LIMITS: BriefLimits = { storiesMax: 8, quickHitsMax: 15 };

export interface Cluster {
  /** Best score first. */
  posts: Post[];
  importance: number;
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const scoreOf = (p: Post) => p.score ?? 0;
const byScore = (a: Post, b: Post) => scoreOf(b) - scoreOf(a);

/**
 * Best post score, plus a bonus for how many different people posted about it
 * (0.5 per extra author, at most 2): five people talking about one thing matters.
 */
export function importance(posts: Post[]): number {
  const authors = new Set(posts.map((p) => p.author_handle.toLowerCase())).size;
  return Math.max(0, ...posts.map(scoreOf)) + Math.min(2, 0.5 * (authors - 1));
}

/**
 * Pure: turn the model's groups into clusters that cover every post exactly once.
 * Unknown ids are dropped, an id already used is skipped, groups left with one post dissolve,
 * and every post not in a group becomes its own cluster. Most important first.
 */
export function normalizeClusters(raw: Clusters, posts: Post[]): Cluster[] {
  const byId = new Map(posts.map((p) => [p.id, p] as const));
  const used = new Set<string>();
  const clusters: Cluster[] = [];
  for (const g of raw.groups) {
    const members: Post[] = [];
    for (const id of g.post_ids) {
      const p = byId.get(id);
      if (!p || used.has(id)) continue;
      members.push(p);
      used.add(id);
    }
    if (members.length >= 2) clusters.push({ posts: members.sort(byScore), importance: importance(members) });
    else for (const p of members) used.delete(p.id);
  }
  for (const p of posts) if (!used.has(p.id)) clusters.push({ posts: [p], importance: importance([p]) });
  return clusters.sort((a, b) => b.importance - a.importance || b.posts.length - a.posts.length);
}

/**
 * Pure: keep only the posts the story pass said it used; the others leave the story.
 * An empty or useless list keeps the whole group.
 */
export function splitUnrelated(posts: Post[], usedIds: string[]): { kept: Post[]; unrelated: Post[] } {
  const used = new Set(usedIds);
  const kept = posts.filter((p) => used.has(p.id));
  return kept.length ? { kept, unrelated: posts.filter((p) => !used.has(p.id)) } : { kept: posts, unrelated: [] };
}

/** The interest topic most of the cluster's score sits in, or "other". */
export function topicOf(posts: Post[], interests: InterestsConfig): string {
  const names = interests.topics.map((t) => t.name);
  const weight = new Map<string, number>();
  for (const p of posts) {
    const t = p.topic && names.includes(p.topic) ? p.topic : "other";
    weight.set(t, (weight.get(t) ?? 0) + scoreOf(p) + 1);
  }
  return [...weight.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "other";
}

const CLUSTER_SYSTEM = [
  "You group posts from X that are about the same specific thing: the same product, model, release, company announcement, paper, incident or event.",
  "Posts that only share a broad theme are NOT the same thing and must not be grouped: \"AI agents\", \"developer tools\", \"security\", \"AI coding\" or \"cloud\" are themes, not things. Two companies each announcing their own agent feature are two separate things.",
  "For each group, first write `about`: the one specific thing in a few words (for example \"Vercel Schedules beta\" or \"Qwen 4 release\"). If you cannot name one specific thing, it is not a group.",
  "Return only groups of 2 or more posts. Leave out posts that stand alone. Each id at most once, and only ids you were given.",
].join(" ");

export function clusterPrompt(posts: Post[]): string {
  const lines = posts.map((p) => `${p.id} | @${p.author_handle} | ${oneLine(p.summary || p.text).slice(0, 200)}`);
  return `One post per line: id | author | summary\n\n${lines.join("\n")}`;
}

const STORY_SYSTEM = [
  "You write one story for a morning news briefing, from posts on X that were grouped as being about the same thing.",
  "First decide the one main thing the best posts are about (one product, release, announcement or event). In `used_ids`, list only the ids of posts about that exact thing; posts from another company or about another product are not used, even when the theme is similar. Write the title and body from the used posts only.",
  "Title: plain, at most 90 characters, says what happened.",
  "Body: 2 or 3 neutral sentences, at most 450 characters, combining the facts from all the posts. Name people as @handle.",
  "No hype, no emojis, no opinions of your own, and no facts that are not in the posts.",
].join(" ");

export function storyPrompt(posts: Post[]): string {
  return posts.map((p) => `id ${p.id}, @${p.author_handle}:\n${oneLine(p.text).slice(0, STORY_TEXT_MAX)}`).join("\n\n");
}

const HEADLINES_SYSTEM = [
  "You write the 'today in 60 seconds' part of a morning briefing.",
  "For each story you get, write one plain line of at most 140 characters saying what happened, so this person can skip the story if the line is enough.",
  "Use the story ids you were given. No hype, no emojis.",
].join(" ");

export function headlinesPrompt(stories: Story[], interests: InterestsConfig): string {
  const body = stories.map((s, i) => `s${i + 1}: ${s.title}\n${oneLine(s.body)}`).join("\n\n");
  return `The person's interests:\n${interestsBlock(interests)}\n\nStories, most important first:\n\n${body}`;
}

/** Pure: one line per known story id, in story order; a story without a usable line gets its title. */
export function normalizeHeadlines(raw: Headlines | null, stories: Story[]): string[] {
  const lines = new Map<string, string>();
  for (const h of raw?.headlines ?? []) {
    const line = oneLine(h.line);
    if (line && !lines.has(h.story)) lines.set(h.story, line);
  }
  const out = stories.map((s, i) => lines.get(`s${i + 1}`) ?? s.title);
  return [...new Set(out)];
}

/**
 * Three passes over the selected posts. Returns null when there are no posts, or when every
 * model call failed (the model is down or useless), so the caller can fall back to the post list.
 */
export async function buildBrief(
  posts: Post[],
  interests: InterestsConfig,
  llm: StructuredDeps = {},
  limits: BriefLimits = DEFAULT_LIMITS,
): Promise<DigestBrief | null> {
  if (!posts.length) return null;
  const log = getLogger();
  let calls = 0;
  let failures = 0;
  const ask = async <T>(step: string, run: (timeoutMs: number) => Promise<T>, timeoutMs: number): Promise<T | null> => {
    calls++;
    try {
      return await run(llm.timeoutMs ?? timeoutMs);
    } catch (err) {
      failures++;
      log.warn({ err: (err as Error).message, step }, "brief step failed");
      return null;
    }
  };

  // Pass 1: cluster.
  const t0 = Date.now();
  const raw =
    posts.length >= 2
      ? await ask("cluster", (t) => generateStructured(Clusters, CLUSTER_SYSTEM, clusterPrompt(posts), { ...llm, timeoutMs: t }), CLUSTER_TIMEOUT_MS)
      : null;
  const clusters = normalizeClusters(raw ?? { groups: [] }, posts);
  log.info(
    {
      posts: posts.length,
      clusters: clusters.length,
      groups: (raw?.groups ?? []).map((g) => `${g.about ?? ""}: ${g.post_ids.join(",")}`),
      ms: Date.now() - t0,
    },
    "brief: clustered",
  );

  // Pass 2: a story per cluster worth one; the rest become quick hits.
  const stories: (Story & { importance: number })[] = [];
  const quickHits: QuickHit[] = [];
  const leftovers: Post[] = [];
  /** The best post of a group becomes a quick hit while there is room; the rest are counted. */
  const quickHit = (group: Post[]) => {
    const [top, ...rest] = group;
    const line = oneLine(top!.summary ?? "");
    if (line && quickHits.length < limits.quickHitsMax) quickHits.push({ line, post: top! });
    else leftovers.push(top!);
    leftovers.push(...rest);
  };
  for (const c of clusters) {
    const worthy = c.posts.length >= 2 || scoreOf(c.posts[0]!) >= SOLO_STORY_SCORE;
    if (worthy && stories.length < limits.storiesMax) {
      const text = await ask(
        "story",
        (t) => generateStructured(StoryText, STORY_SYSTEM, storyPrompt(c.posts), { ...llm, timeoutMs: t }),
        STORY_TIMEOUT_MS,
      );
      const { kept, unrelated } = splitUnrelated(c.posts, text?.used_ids ?? []);
      if (text?.title.trim() && kept.length) {
        stories.push({
          topic: topicOf(kept, interests),
          title: oneLine(text.title),
          body: text.body.trim(),
          sources: kept,
          importance: importance(kept),
        });
        for (const p of unrelated) quickHit([p]);
        continue;
      }
    }
    quickHit(c.posts);
  }
  log.info({ stories: stories.length, quickHits: quickHits.length, ms: Date.now() - t0 }, "brief: stories written");
  if (calls > 0 && failures === calls) return null;

  // Pass 3: headlines for the most important stories (stories are already in importance order).
  const top = stories.slice(0, HEADLINES_MAX);
  let headlines: string[];
  if (top.length) {
    const h = await ask(
      "headlines",
      (t) => generateStructured(Headlines, HEADLINES_SYSTEM, headlinesPrompt(top, interests), { ...llm, timeoutMs: t }),
      STORY_TIMEOUT_MS,
    );
    headlines = normalizeHeadlines(h, top);
  } else {
    headlines = quickHits.slice(0, 3).map((q) => q.line);
  }
  log.info({ ms: Date.now() - t0 }, "brief: done");

  // Show stories grouped by interests.yaml topic order, most important first within a topic.
  const order = interests.topics.map((t) => t.name);
  const rank = (topic: string) => (order.includes(topic) ? order.indexOf(topic) : order.length);
  stories.sort((a, b) => rank(a.topic) - rank(b.topic) || b.importance - a.importance);
  return {
    headlines,
    stories: stories.map(({ importance: _i, ...s }) => s),
    quickHits: quickHits.sort((a, b) => byScore(a.post, b.post)),
    leftovers: leftovers.sort(byScore),
  };
}
