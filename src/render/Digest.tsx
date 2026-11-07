import { renderToStaticMarkup } from "react-dom/server";
import type { DigestBrief, Story } from "../pipeline/brief.js";
import type { PostGroup } from "../pipeline/select.js";
import type { Post, Video } from "../store/db.js";
import { CSS, EMAIL_CSS } from "./styles.js";

export type DigestVariant = "page" | "email";

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
  /** When set, X posts are shown as headlines + stories instead of `groups`. */
  brief?: DigestBrief | null;
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

function PostCard({ p, email }: { p: Post; email: boolean }) {
  return (
    <article className="card">
      <div className="meta">
        <strong>{p.author_name}</strong> @{p.author_handle}
        {p.source ? ` · ${p.source}` : ""}
      </div>
      <p>{p.summary}</p>
      {email ? null : (
        <details>
          <summary>Original text</summary>
          <p>{p.text}</p>
        </details>
      )}
      <a href={safeUrl(p.url)}>Open on X</a>
    </article>
  );
}

function StoryCard({ s }: { s: Story }) {
  return (
    <article className="card story">
      <h4>{s.title}</h4>
      <p>{s.body}</p>
      <div className="meta">
        {s.sources.length > 1 ? `${s.sources.length} posts · ` : ""}
        {s.sources.map((p, i) => (
          <span key={p.id}>
            {i ? " · " : ""}
            <a href={safeUrl(p.url)}>@{p.author_handle}</a>
          </span>
        ))}
      </div>
    </article>
  );
}

/** Stories grouped by topic, keeping the order buildBrief gave them. */
function storyGroups(stories: Story[]): { topic: string; stories: Story[] }[] {
  const groups: { topic: string; stories: Story[] }[] = [];
  for (const s of stories) {
    const last = groups.at(-1);
    if (last && last.topic === s.topic) last.stories.push(s);
    else groups.push({ topic: s.topic, stories: [s] });
  }
  return groups;
}

const postCountOf = (data: DigestData): number =>
  data.brief
    ? data.brief.stories.reduce((n, s) => n + s.sources.length, 0) + data.brief.quickHits.length + data.brief.leftovers.length
    : data.groups.reduce((n, g) => n + g.posts.length, 0);

/** The brief shows only this many skipped posts; the rest are counted in a line. */
export const LEFTOVERS_SHOWN = 5;

/** `1 post`, `2 posts`. */
export const plural = (n: number, noun: string, many = `${noun}s`): string => `${n} ${n === 1 ? noun : many}`;

/** Local, human-readable time like `Nov 5, 05:31`; the raw string if it is not a date. */
export function formatGenerated(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
}

export function Digest({ data, variant = "page" }: { data: DigestData; variant?: DigestVariant }) {
  const email = variant === "email";
  const brief = data.brief ?? null;
  const postCount = postCountOf(data);
  const toc: { id: string; label: string }[] = [];
  if (brief?.headlines.length) toc.push({ id: "today", label: "Today in 60 seconds" });
  if (data.mustWatch.length) toc.push({ id: "must-watch", label: `Must watch today (${data.mustWatch.length})` });
  if (brief) {
    if (brief.stories.length) toc.push({ id: "stories", label: `Stories (${brief.stories.length})` });
    if (brief.quickHits.length) toc.push({ id: "quick-hits", label: `Quick hits (${brief.quickHits.length})` });
    if (brief.leftovers.length) toc.push({ id: "more-posts", label: "More posts" });
  } else if (postCount) toc.push({ id: "x-posts", label: `X posts (${postCount})` });
  if (data.alsoNew.length) toc.push({ id: "also-new", label: `Also new from your channels (${data.alsoNew.length})` });
  const summaryLine = brief
    ? `${plural(data.mustWatch.length + data.alsoNew.length, "video")} · ${plural(brief.stories.length, "story", "stories")} from ${plural(postCount, "post")}`
    : `${plural(data.mustWatch.length + data.alsoNew.length, "video")} · ${plural(postCount, "post")} · about ${data.readingMinutes} min of reading`;
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{`Digest ${data.date}`}</title>
        {/* Constant stylesheet, never source text. */}
        <style dangerouslySetInnerHTML={{ __html: email ? EMAIL_CSS : CSS }} />
      </head>
      <body>
        {email && brief?.headlines[0] ? <div className="preheader">{brief.headlines[0]}</div> : null}
        <main>
          <header>
            <h1>Digest {data.date}</h1>
            <div className="meta">{summaryLine}</div>
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
          {brief?.headlines.length ? (
            <section id="today">
              <h2>Today in 60 seconds</h2>
              <ul className="headlines">
                {brief.headlines.map((h) => (
                  <li key={h}>{h}</li>
                ))}
              </ul>
            </section>
          ) : null}
          {data.mustWatch.length ? (
            <section id="must-watch">
              <h2>Must watch today</h2>
              {data.mustWatch.map((v) => (
                <VideoCard v={v} key={v.id} />
              ))}
            </section>
          ) : null}
          {brief ? (
            <>
              {brief.stories.length ? (
                <section id="stories">
                  <h2>Stories</h2>
                  {storyGroups(brief.stories).map((g) => (
                    <div key={g.topic} id={slug(g.topic)}>
                      <h3>{g.topic}</h3>
                      {g.stories.map((s) => (
                        <StoryCard s={s} key={s.sources[0]!.id} />
                      ))}
                    </div>
                  ))}
                </section>
              ) : null}
              {brief.quickHits.length ? (
                <section id="quick-hits">
                  <h2>Quick hits</h2>
                  <ul className="compact">
                    {brief.quickHits.map((q) => (
                      <li key={q.post.id}>
                        {q.line} <a href={safeUrl(q.post.url)}>@{q.post.author_handle}</a>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
              {brief.leftovers.length ? (
                <section id="more-posts">
                  <h2>More posts</h2>
                  <ul className="compact">
                    {brief.leftovers.slice(0, LEFTOVERS_SHOWN).map((p) => (
                      <li key={p.id}>
                        <a href={safeUrl(p.url)}>{p.summary || p.text.slice(0, 140)}</a>
                        <div className="meta">@{p.author_handle}</div>
                      </li>
                    ))}
                  </ul>
                  {brief.leftovers.length > LEFTOVERS_SHOWN ? (
                    <p className="meta">{`${plural(brief.leftovers.length - LEFTOVERS_SHOWN, "more post")} skipped.`}</p>
                  ) : null}
                </section>
              ) : null}
            </>
          ) : postCount ? (
            <section id="x-posts">
              <h2>X posts</h2>
              {data.groups.map((g) => (
                <div key={g.topic} id={slug(g.topic)}>
                  <h3>{g.topic}</h3>
                  {g.posts.map((p) => (
                    <PostCard p={p} key={p.id} email={email} />
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

export function renderDigest(data: DigestData, opts: { variant?: DigestVariant } = {}): string {
  // React prints the prop name charSet; the lowercase attribute is the conventional spelling.
  return `<!doctype html>${renderToStaticMarkup(<Digest data={data} variant={opts.variant} />).replace("<meta charSet=", "<meta charset=")}`;
}

/** Plain-text version for the email's text part: headlines, story titles and links. */
export function renderDigestText(data: DigestData): string {
  const lines: string[] = [`Digest ${data.date}`, ""];
  for (const w of data.warnings) lines.push(`! ${w}`);
  if (data.warnings.length) lines.push("");
  if (data.brief?.headlines.length) {
    lines.push("TODAY IN 60 SECONDS", ...data.brief.headlines.map((h) => `- ${h}`), "");
  }
  if (data.mustWatch.length) {
    lines.push("MUST WATCH TODAY", ...data.mustWatch.map((v) => `- ${v.title} (${v.channel_name})\n  ${safeUrl(v.url)}`), "");
  }
  if (data.brief) {
    if (data.brief.stories.length) lines.push("STORIES");
    for (const s of data.brief.stories) {
      lines.push(`- ${s.title}`, `  ${s.body}`, ...s.sources.map((p) => `  @${p.author_handle}: ${safeUrl(p.url)}`));
    }
    lines.push("");
    if (data.brief.quickHits.length) {
      lines.push("QUICK HITS", ...data.brief.quickHits.map((q) => `- ${q.line} (@${q.post.author_handle})\n  ${safeUrl(q.post.url)}`), "");
    }
  } else {
    for (const g of data.groups) {
      lines.push(g.topic.toUpperCase(), ...g.posts.map((p) => `- ${p.summary ?? ""} (@${p.author_handle})\n  ${safeUrl(p.url)}`), "");
    }
  }
  if (data.alsoNew.length) {
    lines.push("ALSO NEW", ...data.alsoNew.map((v) => `- ${v.title}\n  ${safeUrl(v.url)}`), "");
  }
  return lines.join("\n");
}
