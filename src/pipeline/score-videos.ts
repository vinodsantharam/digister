import type { ChannelsConfig, InterestsConfig, Tier } from "../config.js";
import { getLogger } from "../log.js";
import { generateStructured, type StructuredDeps } from "../llm/client.js";
import { VideoScoreBatch } from "../llm/schemas.js";
import { setVideoScore, unscoredVideos, type Db, type Video } from "../store/db.js";
import { chunk, interestsBlock, isMuted } from "./common.js";

export const VIDEO_BATCH_SIZE = 10;
export const TIER_BONUS: Record<Tier, number> = { must: 2, high: 1, normal: 0 };

export interface ScoreVideosOptions {
  interests: InterestsConfig;
  channels: ChannelsConfig;
  /** Only videos published at or after this ISO time are considered. */
  sinceIso: string;
  mustWatchMax: number;
  llm?: StructuredDeps;
}

export interface ScoreVideosResult {
  scored: number;
  muted: number;
  shortsSkipped: number;
  /** Videos the model did not return, or whose batch failed; they stay unscored. */
  unscored: number;
  batches: number;
}

const systemPrompt = (max: number) =>
  `You pick what this person must watch today. Prefer videos that match their interests and come from their must-tier channels. Penalize clickbait titles, sponsorship-heavy descriptions, reuploads, and livestream replays. must_watch is true for at most ${max} videos overall. Score each video 0 to 10 and give a short reason (max 140 characters). Return every video id you were given.`;

function describe(v: Video, tier: Tier): string {
  return [
    `id: ${v.id}`,
    `channel: ${v.channel_name} (tier ${tier})`,
    `title: ${v.title}`,
    `published: ${v.published_at}`,
    v.duration_s !== null ? `duration: ${Math.round(v.duration_s / 60)} min` : null,
    `description: ${v.description.slice(0, 800)}`,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Score unscored videos from the window. Mutes score 0, Shorts are skipped unless the channel
 * is must-tier, the rest go to the model in batches of 10. The model's must_watch flags are
 * capped at `mustWatchMax` here, best final score first.
 */
export async function scoreVideos(db: Db, opts: ScoreVideosOptions): Promise<ScoreVideosResult> {
  const log = getLogger();
  const tierOf = new Map(opts.channels.channels.map((c) => [c.id, c.tier] as const));
  const tier = (v: Video): Tier => tierOf.get(v.channel_id) ?? "normal";
  const result: ScoreVideosResult = { scored: 0, muted: 0, shortsSkipped: 0, unscored: 0, batches: 0 };

  const todo: Video[] = [];
  for (const v of unscoredVideos(db, opts.sinceIso)) {
    if (isMuted(`${v.title}\n${v.description}`, opts.interests.mute)) {
      setVideoScore(db, v.id, 0, "muted");
      result.muted++;
    } else if (v.is_short === 1 && tier(v) !== "must") {
      result.shortsSkipped++;
    } else {
      todo.push(v);
    }
  }

  const finals: { id: string; score: number; reason: string; mustWatch: boolean }[] = [];
  const interests = interestsBlock(opts.interests);
  for (const batch of chunk(todo, VIDEO_BATCH_SIZE)) {
    result.batches++;
    const prompt = `The person's interests:\n${interests}\n\nVideos:\n\n${batch.map((v) => describe(v, tier(v))).join("\n\n")}`;
    try {
      const out = await generateStructured(VideoScoreBatch, systemPrompt(opts.mustWatchMax), prompt, opts.llm);
      const byId = new Map(batch.map((v) => [v.id, v] as const));
      for (const item of out.items) {
        const v = byId.get(item.id);
        if (!v) continue;
        byId.delete(item.id);
        finals.push({
          id: v.id,
          score: Math.min(10, item.score + TIER_BONUS[tier(v)]),
          reason: item.reason,
          mustWatch: item.must_watch,
        });
      }
      result.unscored += byId.size;
    } catch (err) {
      log.warn({ err: (err as Error).message }, "video scoring batch failed; videos stay unscored");
      result.unscored += batch.length;
    }
  }

  const allowed = new Set(
    finals
      .filter((f) => f.mustWatch)
      .sort((a, b) => b.score - a.score)
      .slice(0, opts.mustWatchMax)
      .map((f) => f.id),
  );
  for (const f of finals) setVideoScore(db, f.id, f.score, f.reason, allowed.has(f.id));
  result.scored = finals.length;
  return result;
}
