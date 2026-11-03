CREATE TABLE IF NOT EXISTS videos (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  channel_name TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL,
  thumbnail_url TEXT,
  published_at TEXT NOT NULL,
  duration_s INTEGER,
  view_count INTEGER,
  is_short INTEGER,
  first_seen_at TEXT NOT NULL,
  score REAL,
  reason TEXT,
  scored_at TEXT,
  shown_in TEXT
);

CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY,
  author_handle TEXT NOT NULL,
  author_name TEXT NOT NULL,
  text TEXT NOT NULL,
  url TEXT NOT NULL,
  created_at TEXT NOT NULL,
  lang TEXT,
  reply_to_id TEXT,
  quoted_id TEXT,
  conversation_id TEXT,
  like_count INTEGER NOT NULL DEFAULT 0,
  repost_count INTEGER NOT NULL DEFAULT 0,
  media_json TEXT NOT NULL DEFAULT '[]',
  links_json TEXT NOT NULL DEFAULT '[]',
  source TEXT,
  first_seen_at TEXT NOT NULL,
  score REAL,
  topic TEXT,
  summary TEXT,
  scored_at TEXT,
  shown_in TEXT
);

CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  x_posts_seen INTEGER NOT NULL DEFAULT 0,
  videos_seen INTEGER NOT NULL DEFAULT 0,
  digest_path TEXT,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_videos_published ON videos(published_at);
CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at);
