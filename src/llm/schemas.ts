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

/** Brief pass 1: groups of post ids about the same specific thing. */
export const Clusters = z.object({
  groups: z.array(z.object({ about: z.string().default(""), post_ids: z.array(z.string()).min(1) })),
});

/** Brief pass 2: one story written from one group of posts. */
export const StoryText = z.object({
  /** Ids of the posts the story is about; the others in the group are not about its main thing. */
  used_ids: z.array(z.string()).default([]),
  title: z.string().max(90),
  body: z.string().max(450),
});

/** Brief pass 3: one headline line per story, by story id. */
export const Headlines = z.object({
  headlines: z.array(z.object({ story: z.string(), line: z.string().max(140) })),
});

export type Clusters = z.input<typeof Clusters>;
export type Headlines = z.infer<typeof Headlines>;
export type VideoScore = z.infer<typeof VideoScore>;
export type PostScore = z.infer<typeof PostScore>;
export type VideoScoreBatch = z.infer<typeof VideoScoreBatch>;
export type PostScoreBatch = z.infer<typeof PostScoreBatch>;
