import { z } from "zod";

export const VideoScore = z.object({
  id: z.string(),
  score: z.number().min(0).max(10),
  must_watch: z.boolean(),
  reason: z.string().max(140),
});

export const PostScore = z.object({
  id: z.string(),
  score: z.number().min(0).max(10),
  /** One of the interest names or "other". */
  topic: z.string(),
  summary: z.string().max(200),
});

export const VideoScoreBatch = z.object({ items: z.array(VideoScore) });
export const PostScoreBatch = z.object({ items: z.array(PostScore) });

export type VideoScore = z.infer<typeof VideoScore>;
export type PostScore = z.infer<typeof PostScore>;
export type VideoScoreBatch = z.infer<typeof VideoScoreBatch>;
export type PostScoreBatch = z.infer<typeof PostScoreBatch>;
