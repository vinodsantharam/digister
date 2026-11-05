import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { formatDuration, formatGenerated, plural, renderDigest, safeUrl, type DigestData } from "../src/render/Digest.js";
import { writeDigest } from "../src/render/write.js";
import type { Post, Video } from "../src/store/db.js";

// The footer shows local time; pin the zone so the snapshot is stable.
process.env.TZ = "UTC";

const video = (id: string, over: Partial<Video> = {}): Video => ({
  id, channel_id: "C", channel_name: "Fireship", title: `Title ${id}`, description: "Desc ".repeat(100),
  url: `https://www.youtube.com/watch?v=${id}`, thumbnail_url: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
  published_at: "2026-11-02T10:00:00Z", duration_s: 754, view_count: null, is_short: null, first_seen_at: "",
  score: 9, reason: "Matches local AI", scored_at: "", shown_in: null, must_watch: 1, ...over,
});
const post = (id: string, over: Partial<Post> = {}): Post => ({
  id, author_handle: "alice", author_name: "Alice", text: "Original <b>text</b> & more", url: `https://x.com/alice/status/${id}`,
  created_at: "2026-11-02T10:00:00Z", lang: "en", reply_to_id: null, quoted_id: null, conversation_id: null, like_count: 1,
  repost_count: 1, media_json: "[]", links_json: "[]", source: null, first_seen_at: "", score: 7, topic: "AI",
  summary: "A summary.", scored_at: "", shown_in: null, ...over,
});

const data: DigestData = {
  date: "2026-11-03",
  generatedAt: "2026-11-03T05:30:00.000Z",
  warnings: ["X needs login: run `digister x login`"],
  mustWatch: [video("v1")],
  alsoNew: [video("v2", { duration_s: null, must_watch: 0, score: 5 })],
  groups: [{ topic: "AI", posts: [post("p1")] }],
  readingMinutes: 3,
  filtered: 4,
};

/** Every non-void opening tag has a matching close, in order. */
function balanced(html: string): boolean {
  const voids = new Set(["meta", "img", "br", "hr", "input", "link"]);
  const stack: string[] = [];
  for (const m of html.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)[^>]*?(\/?)>/g)) {
    const [, close, name, self] = m;
    const tag = name!.toLowerCase();
    if (voids.has(tag) || self) continue;
    if (close) {
      if (stack.pop() !== tag) return false;
    } else stack.push(tag);
  }
  return stack.length === 0;
}

describe("renderDigest", () => {
  const html = renderDigest(data);

  it("matches the snapshot", () => {
    expect(html).toMatchSnapshot();
  });

  it("is a doctype page with charset and viewport, no script, balanced tags", () => {
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain('<meta charset="utf-8"/>');
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1"/>');
    expect(html.toLowerCase()).not.toContain("<script");
    expect(balanced(html)).toBe(true);
  });

  it("lazy-loads thumbnails with alt text and shows the warning", () => {
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('alt="Thumbnail: Title v1"');
    expect(html).toContain("X needs login");
  });

  it("escapes source text and neutralizes non-http links", () => {
    const evil = renderDigest({
      ...data,
      mustWatch: [video("v1", { title: "<img src=x onerror=alert(1)>", url: "javascript:alert(1)" })],
    });
    expect(evil).not.toContain("<img src=x");
    expect(evil).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(evil).toContain('href="#"');
    expect(html).toContain("Original &lt;b&gt;text&lt;/b&gt; &amp; more");
  });

  it("renders an empty digest", () => {
    const empty = renderDigest({ ...data, mustWatch: [], alsoNew: [], groups: [], warnings: [] });
    expect(empty).toContain("Nothing new");
    expect(balanced(empty)).toBe(true);
  });
});

describe("helpers", () => {
  it("formats durations and urls", () => {
    expect(formatDuration(754)).toBe("12:34");
    expect(formatDuration(3723)).toBe("1:02:03");
    expect(formatDuration(null)).toBeNull();
    expect(safeUrl("ftp://x")).toBe("#");
    expect(safeUrl("https://a.b/c")).toBe("https://a.b/c");
  });
});

describe("writeDigest", () => {
  it("writes the dated file and latest.html, leaving no temp files", () => {
    const dir = path.join(mkdtempSync(path.join(tmpdir(), "digister-w-")), "out");
    const file = writeDigest("<!doctype html>hi", dir, "2026-11-03");
    expect(path.basename(file)).toBe("digest-2026-11-03.html");
    expect(readFileSync(file, "utf8")).toBe("<!doctype html>hi");
    expect(readFileSync(path.join(dir, "latest.html"), "utf8")).toBe("<!doctype html>hi");
    expect(readdirSync(dir).sort()).toEqual(["digest-2026-11-03.html", "latest.html"]);
    expect(path.basename(writeDigest("second", dir, "2026-11-03"))).toBe("digest-2026-11-03-2.html");
    expect(readFileSync(file, "utf8")).toBe("<!doctype html>hi");
  });
});

describe("pluralisation and generated time", () => {
  it("pluralises counts", () => {
    expect(plural(1, "post")).toBe("1 post");
    expect(plural(0, "video")).toBe("0 videos");
    expect(plural(2, "item")).toBe("2 items");
  });
  it("renders singular counts and a readable time in the digest", () => {
    const html = renderDigest({ ...data, alsoNew: [], filtered: 1 });
    expect(html).toContain("1 video");
    expect(html).not.toContain("1 videos");
    expect(html).toContain("1 post");
    expect(html).toContain("Generated Nov 3, 05:30 · 1 item filtered out");
  });
  it("formats local time and tolerates junk", () => {
    expect(formatGenerated("2026-11-05T05:31:12.000Z")).toBe("Nov 5, 05:31");
    expect(formatGenerated("not a date")).toBe("not a date");
  });
});
