import { renderToStaticMarkup } from "react-dom/server";
import type { PostGroup } from "../pipeline/select.js";
import type { Post, Video } from "../store/db.js";
import { CSS } from "./styles.js";

export interface DigestData {
  /** YYYY-MM-DD */
  date: string;
  /** ISO time the digest was generated. */
  generatedAt: string;
  /** Shown in the header, e.g. "X needs login". */
  warnings: string[];
  mustWatch: Video[];
  alsoNew: Video[];
  groups: PostGroup[];
  readingMinutes: number;
  /** Items dropped before the digest (muted, Shorts, replies...), for the footer. */
  filtered: number;
}

/** Only http(s) links are rendered as links; anything else becomes "#". */
export function safeUrl(u: string): string {
  try {
    const p = new URL(u);
    return p.protocol === "https:" || p.protocol === "http:" ? p.href : "#";
  } catch {
    return "#";
  }
}

export function formatDuration(s: number | null): string | null {
  if (s === null) return null;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
}

const thumb = (v: Video) => v.thumbnail_url ?? `https://i.ytimg.com/vi/${encodeURIComponent(v.id)}/hqdefault.jpg`;
const slug = (s: string) => `topic-${s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "other"}`;

function VideoCard({ v }: { v: Video }) {
  const dur = formatDuration(v.duration_s);
  return (
    <article className="card">
      <img src={thumb(v)} alt={`Thumbnail: ${v.title}`} loading="lazy" width="640" height="360" />
      <h4>
        <a href={safeUrl(v.url)}>{v.title}</a>
      </h4>
      <div className="meta">
        {v.channel_name}
        {dur ? ` · ${dur}` : ""}
      </div>
      {v.reason ? <p className="reason">{v.reason}</p> : null}
      {v.description ? <p className="desc">{v.description.slice(0, 300)}</p> : null}
    </article>
  );
}

function PostCard({ p }: { p: Post }) {
  return (
    <article className="card">
      <div className="meta">
        <strong>{p.author_name}</strong> @{p.author_handle}
        {p.source ? ` · ${p.source}` : ""}
      </div>
      <p>{p.summary}</p>
      <details>
        <summary>Original text</summary>
        <p>{p.text}</p>
      </details>
      <a href={safeUrl(p.url)}>Open on X</a>
    </article>
  );
}

/** `1 post`, `2 posts`. */
export const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? "" : "s"}`;

/** Local, human-readable time like `Nov 5, 05:31`; the raw string if it is not a date. */
export function formatGenerated(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
}

export function Digest({ data }: { data: DigestData }) {
  const postCount = data.groups.reduce((n, g) => n + g.posts.length, 0);
  const toc: { id: string; label: string }[] = [];
  if (data.mustWatch.length) toc.push({ id: "must-watch", label: `Must watch today (${data.mustWatch.length})` });
  if (postCount) toc.push({ id: "x-posts", label: `X posts (${postCount})` });
  if (data.alsoNew.length) toc.push({ id: "also-new", label: `Also new from your channels (${data.alsoNew.length})` });
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{`Digest ${data.date}`}</title>
        {/* Constant stylesheet, never source text. */}
        <style dangerouslySetInnerHTML={{ __html: CSS }} />
      </head>
      <body>
        <main>
          <header>
            <h1>Digest {data.date}</h1>
            <div className="meta">
              {plural(data.mustWatch.length + data.alsoNew.length, "video")} · {plural(postCount, "post")} · about {data.readingMinutes} min of reading
            </div>
            {data.warnings.map((w) => (
              <div className="warn" key={w} role="alert">
                {w}
              </div>
            ))}
          </header>
          {toc.length ? (
            <nav aria-label="Contents">
              <ul>
                {toc.map((t) => (
                  <li key={t.id}>
                    <a href={`#${t.id}`}>{t.label}</a>
                  </li>
                ))}
              </ul>
            </nav>
          ) : (
            <p>Nothing new worth your time today.</p>
          )}
          {data.mustWatch.length ? (
            <section id="must-watch">
              <h2>Must watch today</h2>
              {data.mustWatch.map((v) => (
                <VideoCard v={v} key={v.id} />
              ))}
            </section>
          ) : null}
          {postCount ? (
            <section id="x-posts">
              <h2>X posts</h2>
              {data.groups.map((g) => (
                <div key={g.topic} id={slug(g.topic)}>
                  <h3>{g.topic}</h3>
                  {g.posts.map((p) => (
                    <PostCard p={p} key={p.id} />
                  ))}
                </div>
              ))}
            </section>
          ) : null}
          {data.alsoNew.length ? (
            <section id="also-new">
              <h2>Also new from your channels</h2>
              <ul className="compact">
                {data.alsoNew.map((v) => (
                  <li key={v.id}>
                    <a href={safeUrl(v.url)}>{v.title}</a>
                    <div className="meta">
                      {v.channel_name}
                      {formatDuration(v.duration_s) ? ` · ${formatDuration(v.duration_s)}` : ""}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          <footer>
            Generated {formatGenerated(data.generatedAt)} · {plural(data.filtered, "item")} filtered out
          </footer>
        </main>
      </body>
    </html>
  );
}

export function renderDigest(data: DigestData): string {
  // React prints the prop name charSet; the lowercase attribute is the conventional spelling.
  return `<!doctype html>${renderToStaticMarkup(<Digest data={data} />).replace("<meta charSet=", "<meta charset=")}`;
}
