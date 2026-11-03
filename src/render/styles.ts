/** Inline CSS for the digest: one column, system fonts, light and dark, big tap targets. */
export const CSS = `
:root{color-scheme:light dark;--bg:#fbfbf9;--fg:#1c1c1e;--muted:#6b6b70;--card:#ffffff;--line:#e3e3df;--accent:#0b57d0;--warn-bg:#fff4d6;--warn-fg:#5c4300}
@media (prefers-color-scheme: dark){:root{--bg:#121214;--fg:#ececee;--muted:#9a9aa1;--card:#1c1c20;--line:#2e2e33;--accent:#8ab4f8;--warn-bg:#3a3012;--warn-fg:#f3dc9a}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:18px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;-webkit-text-size-adjust:100%}
main{max-width:680px;margin:0 auto;padding:16px}
a{color:var(--accent)}
h1{font-size:1.6rem;margin:.2em 0}
h2{font-size:1.3rem;margin:1.6em 0 .6em;padding-top:.4em;border-top:1px solid var(--line)}
h3{font-size:1.05rem;margin:1.2em 0 .4em;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
.meta{color:var(--muted);font-size:.9rem}
.warn{background:var(--warn-bg);color:var(--warn-fg);padding:.6em .9em;border-radius:10px;margin:.6em 0}
nav ul{list-style:none;padding:0;margin:.5em 0}
nav a{display:block;padding:.7em 0;min-height:44px;text-decoration:none;border-bottom:1px solid var(--line)}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px;margin:12px 0}
.card img{display:block;width:100%;height:auto;aspect-ratio:16/9;object-fit:cover;border-radius:8px;background:var(--line);margin-bottom:8px;color:var(--muted);font-size:.85rem}
.card h4{font-size:1.1rem;line-height:1.3;margin:.2em 0}
.card h4 a{display:block;padding:.2em 0;min-height:44px}
.reason{font-style:italic}
.desc{color:var(--muted);font-size:.95rem}
details{margin:.5em 0}
summary{cursor:pointer;padding:.6em 0;min-height:44px;color:var(--accent)}
details p{white-space:pre-wrap;margin:.3em 0}
.compact{list-style:none;padding:0;margin:0}
.compact li{padding:.55em 0;border-bottom:1px solid var(--line)}
.compact a{display:inline-block;min-height:44px;line-height:44px}
footer{margin-top:2em;padding-top:1em;border-top:1px solid var(--line);color:var(--muted);font-size:.85rem}
`;
