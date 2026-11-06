import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { digisterHome, expandHome } from "./paths.js";

const DigisterSchema = z.object({
  output_dir: z.string().min(1).transform(expandHome),
  ollama: z
    .object({
      base_url: z.string().url().default("http://localhost:11434"),
      chat_model: z.string().min(1).default("qwen3:8b"),
    })
    .prefault({}),
  x: z
    .object({
      enabled: z.boolean().default(true),
      list_urls: z.array(z.string().url()).default([]),
      include_following: z.boolean().default(false),
      max_posts_per_run: z.number().int().positive().default(300),
      lookback_hours: z.number().positive().default(30),
      headless: z.boolean().default(true),
      graphql_operations: z
        .array(z.string())
        .default(["ListLatestTweetsTimeline", "HomeLatestTimeline", "TweetDetail"]),
    })
    .prefault({}),
  youtube: z
    .object({
      lookback_hours: z.number().positive().default(36),
      data_api_key: z.string().default(""),
    })
    .prefault({}),
  digest: z
    .object({
      must_watch_max: z.number().int().nonnegative().default(3),
      posts_max: z.number().int().nonnegative().default(20),
      reading_minutes: z.number().positive().default(25),
      /** "brief": headlines + stories written by the model; "list": one card per post. */
      mode: z.enum(["brief", "list"]).default("brief"),
      brief_posts_max: z.number().int().positive().default(25),
      brief_min_score: z.number().min(0).max(10).default(5),
    })
    .prefault({}),
  email: z
    .object({
      enabled: z.boolean().default(false),
      to: z.string().default(""),
      from: z.string().default(""),
      smtp_host: z.string().default("smtp.gmail.com"),
      smtp_port: z.number().int().positive().default(465),
      smtp_user: z.string().default(""),
    })
    .prefault({})
    .refine((e) => !e.enabled || /^[^@\s]+@[^@\s]+$/.test(e.to), {
      message: "email.to must be an email address when email.enabled is true",
      path: ["to"],
    }),
});

export const TierSchema = z.enum(["must", "high", "normal"]);

const ChannelsSchema = z.object({
  channels: z
    .array(
      z.object({
        id: z.string().min(1),
        name: z.string().min(1),
        tier: TierSchema,
      }),
    )
    .default([]),
});

const InterestsSchema = z.object({
  topics: z.array(
    z.object({
      name: z.string().min(1),
      weight: z.number().default(1),
      description: z.string().default(""),
    }),
  ),
  mute: z.array(z.string()).default([]),
});

export type DigisterConfig = z.infer<typeof DigisterSchema>;
export type ChannelsConfig = z.infer<typeof ChannelsSchema>;
export type InterestsConfig = z.infer<typeof InterestsSchema>;
export type Tier = z.infer<typeof TierSchema>;

export class ConfigError extends Error {}

export interface LoadOptions {
  /** Directories searched in order. Default: DIGISTER_HOME/config, then ./config. */
  dirs?: string[];
}

function searchDirs(opts: LoadOptions): string[] {
  return opts.dirs ?? [path.join(digisterHome(), "config"), path.resolve("config")];
}

/** Path of the first existing `<name>.yaml` in the search dirs, or undefined. */
export function findConfigFile(name: string, opts: LoadOptions = {}): string | undefined {
  return searchDirs(opts)
    .map((d) => path.join(d, `${name}.yaml`))
    .find((p) => existsSync(p));
}

function loadFile<S extends z.ZodType>(name: string, schema: S, opts: LoadOptions): z.output<S> {
  const file = findConfigFile(name, opts);
  if (!file) {
    const example = path.join(path.resolve("config"), `${name}.example.yaml`);
    const where = searchDirs(opts).map((d) => path.join(d, `${name}.yaml`)).join(" or ");
    throw new ConfigError(
      `${name}.yaml not found. Copy ${example} to ${where} and edit it.`,
    );
  }
  let raw: unknown;
  try {
    raw = parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new ConfigError(`${file}: invalid YAML: ${(err as Error).message}`);
  }
  const result = schema.safeParse(raw ?? {});
  if (!result.success) {
    const problems = result.error.issues
      .map((i) => `  ${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`)
      .join("\n");
    throw new ConfigError(`${file}: invalid config\n${problems}`);
  }
  return result.data;
}

export const loadDigisterConfig = (opts: LoadOptions = {}): DigisterConfig =>
  loadFile("digister", DigisterSchema, opts);
export const loadChannels = (opts: LoadOptions = {}): ChannelsConfig =>
  loadFile("channels", ChannelsSchema, opts);
export const loadInterests = (opts: LoadOptions = {}): InterestsConfig =>
  loadFile("interests", InterestsSchema, opts);
