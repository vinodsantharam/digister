import { createInterface } from "node:readline/promises";
import { chromium, type BrowserContext } from "playwright";
import { getPaths } from "../../paths.js";

export type XState = "logged_in" | "logged_out" | "blocked";

export interface XStateInput {
  /** Final URL after redirects. */
  url: string;
  /** HTTP status of the main navigation, if known. */
  status: number | null;
  /** Page HTML (or a snippet of it). */
  html: string;
  /** Whether an `auth_token` cookie exists for .x.com. The value is never read. */
  hasAuthCookie: boolean;
}

const LOGIN_URL_RE = /^https?:\/\/[^/]*(x|twitter)\.com\/(i\/flow\/login|login|i\/flow\/signup)(\/|\?|$)/i;
const CHALLENGE_URL_RE = /\/account\/access|\/i\/flow\/(consent|challenge)|\/account\/login_challenge/i;
const CHALLENGE_HTML_RE =
  /Verify you are human|unusual (login )?activity|Your account has been locked|Your account is suspended|Confirm your identity|Just a moment\.\.\.|Access Denied|Arkose|captcha/i;

/** Pure: classify a loaded X page. Blocked wins over logged out, logged out wins over logged in. */
export function detectXState(input: XStateInput): XState {
  const { url, status, html, hasAuthCookie } = input;
  if (status !== null && status >= 400) return "blocked";
  if (CHALLENGE_URL_RE.test(url) || CHALLENGE_HTML_RE.test(html)) return "blocked";
  if (LOGIN_URL_RE.test(url) || !hasAuthCookie) return "logged_out";
  return "logged_in";
}

export interface BrowserOptions {
  headless: boolean;
}

/** Launch the persistent Chromium profile the user logged into. */
export async function openXContext(opts: BrowserOptions): Promise<BrowserContext> {
  return chromium.launchPersistentContext(getPaths().xProfile, {
    headless: opts.headless,
    viewport: { width: 1280, height: 900 },
    locale: "en-US",
  });
}

export async function hasAuthCookie(context: BrowserContext): Promise<boolean> {
  const cookies = await context.cookies(["https://x.com"]);
  return cookies.some((c) => c.name === "auth_token" && c.domain.replace(/^\./, "") === "x.com");
}

/** Headed login: the user types credentials by hand; we only check the cookie exists. */
export async function xLogin(
  waitForEnter: () => Promise<void> = defaultWaitForEnter,
): Promise<boolean> {
  const context = await openXContext({ headless: false });
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto("https://x.com/login", { timeout: 60_000 });
    console.log("Log in in the browser window, then press Enter here");
    await waitForEnter();
    return await hasAuthCookie(context);
  } finally {
    await context.close();
  }
}

async function defaultWaitForEnter(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    await rl.question("");
  } finally {
    rl.close();
  }
}

/** Load /home with the configured mode and classify the session. */
export async function xCheck(opts: BrowserOptions): Promise<XState> {
  const context = await openXContext(opts);
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    const response = await page.goto("https://x.com/home", { timeout: 45_000, waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3_000);
    return detectXState({
      url: page.url(),
      status: response?.status() ?? null,
      html: (await page.content()).slice(0, 200_000),
      hasAuthCookie: await hasAuthCookie(context),
    });
  } finally {
    await context.close();
  }
}

export interface XCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "None";
}

const AUTH_TOKEN_RE = /^[0-9a-f]{40}$/i;
const CT0_RE = /^[0-9a-f]{32,160}$/i;

/** Pure: turn the two session cookie values copied from a normal browser into Playwright cookies. */
export function buildXCookies(authToken: string, ct0: string, now: number = Date.now()): XCookie[] {
  const auth = authToken.trim().replace(/^"|"$/g, "");
  const csrf = ct0.trim().replace(/^"|"$/g, "");
  if (!AUTH_TOKEN_RE.test(auth)) {
    throw new Error("auth_token looks wrong: it should be 40 letters and digits (0-9, a-f). Copy the Value column, not the name.");
  }
  if (!CT0_RE.test(csrf)) {
    throw new Error("ct0 looks wrong: it should be a long run of letters and digits (0-9, a-f). Copy the Value column, not the name.");
  }
  const expires = Math.floor(now / 1000) + 365 * 24 * 3600;
  const base = { domain: ".x.com", path: "/", expires, secure: true, sameSite: "None" as const };
  return [
    { ...base, name: "auth_token", value: auth, httpOnly: true },
    { ...base, name: "ct0", value: csrf, httpOnly: false },
  ];
}

/** Pure: read a Cookie-Editor / EditThisCookie JSON export and pick the x.com session cookies. */
export function parseCookieExport(json: string, now: number = Date.now()): XCookie[] {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new Error('Cookie file is not valid JSON. Export it from Cookie-Editor with "Export as JSON".');
  }
  if (!Array.isArray(data)) throw new Error("Cookie file should be a JSON array of cookies.");
  const pick = (name: string): string | undefined => {
    for (const c of data as unknown[]) {
      if (!c || typeof c !== "object") continue;
      const { name: n, value, domain } = c as { name?: unknown; value?: unknown; domain?: unknown };
      const d = typeof domain === "string" ? domain.replace(/^\./, "") : "x.com";
      if (n === name && typeof value === "string" && (d === "x.com" || d.endsWith(".x.com"))) return value;
    }
    return undefined;
  };
  const auth = pick("auth_token");
  const ct0 = pick("ct0");
  if (!auth) throw new Error("No x.com auth_token cookie in the file. Export it while logged in on x.com.");
  if (!ct0) throw new Error("No x.com ct0 cookie in the file. Export it while logged in on x.com.");
  return buildXCookies(auth, ct0, now);
}

export interface ImportDeps {
  openContext?: (opts: BrowserOptions) => Promise<Pick<BrowserContext, "addCookies" | "close">>;
  verify?: (opts: BrowserOptions) => Promise<XState>;
}

/** Save the cookies into the Digister profile, then check the session. Cookie values are never logged. */
export async function xImportCookies(cookies: XCookie[], deps: ImportDeps = {}): Promise<XState> {
  const context = await (deps.openContext ?? openXContext)({ headless: true });
  try {
    await context.addCookies(cookies);
  } finally {
    await context.close();
  }
  return (deps.verify ?? xCheck)({ headless: true });
}
