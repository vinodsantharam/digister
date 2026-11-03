import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { getPaths } from "../paths.js";

export type Db = Database.Database;

export interface Video {
  id: string;
  channel_id: string;
  channel_name: string;
  title: string;
  description: string;
  url: string;
  thumbnail_url: string | null;
  published_at: string;
  duration_s: number | null;
  view_count: number | null;
  is_short: number | null;
  first_seen_at: string;
  score: number | null;
  reason: string | null;
  scored_at: string | null;
  shown_in: string | null;
}

export interface Post {
  id: string;
  author_handle: string;
  author_name: string;
  text: string;
  url: string;
  created_at: string;
  lang: string | null;
  reply_to_id: string | null;
  quoted_id: string | null;
  conversation_id: string | null;
  like_count: number;
  repost_count: number;
  media_json: string;
  links_json: string;
  source: string | null;
  first_seen_at: string;
  score: number | null;
  topic: string | null;
  summary: string | null;
  scored_at: string | null;
  shown_in: string | null;
}

/** Fields the caller provides; scoring and bookkeeping columns are filled by the store. */
export type VideoInput = Omit<
  Video,
  "first_seen_at" | "score" | "reason" | "scored_at" | "shown_in" | "duration_s" | "view_count" | "is_short" | "thumbnail_url" | "description"
> &
  Partial<Pick<Video, "first_seen_at" | "duration_s" | "view_count" | "is_short" | "thumbnail_url" | "description">>;

export type PostInput = Omit<
  Post,
  "first_seen_at" | "score" | "topic" | "summary" | "scored_at" | "shown_in" | "lang" | "reply_to_id" | "quoted_id" | "conversation_id" | "source" | "media_json" | "links_json" | "like_count" | "repost_count"
> &
  Partial<Pick<Post, "first_seen_at" | "lang" | "reply_to_id" | "quoted_id" | "conversation_id" | "source" | "media_json" | "links_json" | "like_count" | "repost_count">>;

export type Kind = "video" | "post";

const TABLE = { video: "videos", post: "posts" } as const;

/** Open (or create) a database and apply the schema idempotently. Use ":memory:" in tests. */
export function openDb(file: string = getPaths().db): Db {
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
  return db;
}

const now = () => new Date().toISOString();

/**
 * Insert a video; if it exists, refresh metadata (title, description, thumbnail) and fill
 * in duration/view count/is_short, but keep first_seen_at and any score.
 */
export function upsertVideo(db: Db, v: VideoInput): void {
  db.prepare(
    `INSERT INTO videos (id, channel_id, channel_name, title, description, url, thumbnail_url,
       published_at, duration_s, view_count, is_short, first_seen_at)
     VALUES (@id, @channel_id, @channel_name, @title, @description, @url, @thumbnail_url,
       @published_at, @duration_s, @view_count, @is_short, @first_seen_at)
     ON CONFLICT(id) DO UPDATE SET
       channel_name = excluded.channel_name,
       title = excluded.title,
       description = excluded.description,
       thumbnail_url = COALESCE(excluded.thumbnail_url, thumbnail_url),
       duration_s = COALESCE(excluded.duration_s, duration_s),
       view_count = COALESCE(excluded.view_count, view_count),
       is_short = COALESCE(excluded.is_short, is_short)`,
  ).run({
    description: "",
    thumbnail_url: null,
    duration_s: null,
    view_count: null,
    is_short: null,
    first_seen_at: now(),
    ...v,
  });
}

/** Insert a post, ignoring it when the id already exists (first_seen_at is kept). */
export function upsertPost(db: Db, p: PostInput): void {
  db.prepare(
    `INSERT OR IGNORE INTO posts (id, author_handle, author_name, text, url, created_at, lang,
       reply_to_id, quoted_id, conversation_id, like_count, repost_count, media_json, links_json,
       source, first_seen_at)
     VALUES (@id, @author_handle, @author_name, @text, @url, @created_at, @lang,
       @reply_to_id, @quoted_id, @conversation_id, @like_count, @repost_count, @media_json,
       @links_json, @source, @first_seen_at)`,
  ).run({
    lang: null,
    reply_to_id: null,
    quoted_id: null,
    conversation_id: null,
    like_count: 0,
    repost_count: 0,
    media_json: "[]",
    links_json: "[]",
    source: null,
    first_seen_at: now(),
    ...p,
  });
}

/** Videos published since `sinceIso` that are not yet scored and not yet shown. */
export function unscoredVideos(db: Db, sinceIso: string): Video[] {
  return db
    .prepare(
      `SELECT * FROM videos WHERE score IS NULL AND shown_in IS NULL AND published_at >= ?
       ORDER BY published_at DESC`,
    )
    .all(sinceIso) as Video[];
}

/** Posts created since `sinceIso` that are not yet scored and not yet shown. */
export function unscoredPosts(db: Db, sinceIso: string): Post[] {
  return db
    .prepare(
      `SELECT * FROM posts WHERE score IS NULL AND shown_in IS NULL AND created_at >= ?
       ORDER BY created_at DESC`,
    )
    .all(sinceIso) as Post[];
}

export function setVideoScore(db: Db, id: string, score: number, reason: string): void {
  db.prepare("UPDATE videos SET score = ?, reason = ?, scored_at = ? WHERE id = ?").run(
    score,
    reason,
    now(),
    id,
  );
}

export function setPostScore(
  db: Db,
  id: string,
  score: number,
  topic: string,
  summary: string,
): void {
  db.prepare("UPDATE posts SET score = ?, topic = ?, summary = ?, scored_at = ? WHERE id = ?").run(
    score,
    topic,
    summary,
    now(),
    id,
  );
}

/** Mark items as shown in the digest of `digestDate` (YYYY-MM-DD). */
export function markShown(db: Db, kind: Kind, ids: string[], digestDate: string): void {
  const stmt = db.prepare(`UPDATE ${TABLE[kind]} SET shown_in = ? WHERE id = ?`);
  db.transaction(() => {
    for (const id of ids) stmt.run(digestDate, id);
  })();
}

export function startRun(db: Db): number {
  const r = db
    .prepare("INSERT INTO runs (started_at, status) VALUES (?, 'running')")
    .run(now());
  return Number(r.lastInsertRowid);
}

export interface RunResult {
  status: string;
  x_posts_seen?: number;
  videos_seen?: number;
  digest_path?: string | null;
  error?: string | null;
}

export function finishRun(db: Db, id: number, r: RunResult): void {
  db.prepare(
    `UPDATE runs SET finished_at = ?, status = ?, x_posts_seen = ?, videos_seen = ?,
       digest_path = ?, error = ? WHERE id = ?`,
  ).run(now(), r.status, r.x_posts_seen ?? 0, r.videos_seen ?? 0, r.digest_path ?? null, r.error ?? null, id);
}
