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
