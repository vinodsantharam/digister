import { describe, expect, it } from "vitest";
import { buildXCookies, detectXState, parseCookieExport, xImportCookies } from "../src/sources/x/browser.js";

const ok = { url: "https://x.com/home", status: 200, html: "<html><body>Home</body></html>", hasAuthCookie: true };

describe("detectXState", () => {
  it("logged in on /home with auth cookie", () => {
    expect(detectXState(ok)).toBe("logged_in");
  });
  it("logged out when redirected to login", () => {
    expect(detectXState({ ...ok, url: "https://x.com/i/flow/login?redirect_after_login=%2Fhome" })).toBe("logged_out");
    expect(detectXState({ ...ok, url: "https://x.com/login" })).toBe("logged_out");
  });
  it("logged out when there is no auth cookie", () => {
    expect(detectXState({ ...ok, hasAuthCookie: false })).toBe("logged_out");
  });
  it("blocked on HTTP 4xx", () => {
    expect(detectXState({ ...ok, status: 403 })).toBe("blocked");
    expect(detectXState({ ...ok, status: 429 })).toBe("blocked");
  });
  it("blocked on a challenge page", () => {
    expect(detectXState({ ...ok, html: "<h1>Verify you are human</h1>" })).toBe("blocked");
    expect(detectXState({ ...ok, url: "https://x.com/account/access" })).toBe("blocked");
    expect(detectXState({ ...ok, html: "<title>Just a moment...</title>" })).toBe("blocked");
  });
});

const AUTH = "a".repeat(40);
const CT0 = "b".repeat(64);

describe("buildXCookies", () => {
  it("builds auth_token and ct0 cookies for .x.com", () => {
    const cookies = buildXCookies(`  ${AUTH}\n`, `"${CT0}"`, 0);
    expect(cookies.map((c) => [c.name, c.value, c.domain, c.httpOnly, c.secure])).toEqual([
      ["auth_token", AUTH, ".x.com", true, true],
      ["ct0", CT0, ".x.com", false, true],
    ]);
    expect(cookies[0]!.expires).toBe(365 * 24 * 3600);
  });
  it("rejects bad or empty values", () => {
    expect(() => buildXCookies("", CT0)).toThrow(/auth_token/);
    expect(() => buildXCookies("auth_token", CT0)).toThrow(/auth_token/);
    expect(() => buildXCookies(AUTH, "xyz")).toThrow(/ct0/);
  });
});

describe("parseCookieExport", () => {
  it("picks x.com session cookies from a mixed export", () => {
    const json = JSON.stringify([
      { name: "auth_token", value: "c".repeat(40), domain: ".example.com" },
      { name: "auth_token", value: AUTH, domain: ".x.com" },
      { name: "ct0", value: CT0, domain: "x.com" },
      { name: "guest_id", value: "v1", domain: ".x.com" },
    ]);
    expect(parseCookieExport(json).map((c) => c.value)).toEqual([AUTH, CT0]);
  });
  it("errors when ct0 is missing or the JSON is invalid", () => {
    expect(() => parseCookieExport(JSON.stringify([{ name: "auth_token", value: AUTH, domain: ".x.com" }]))).toThrow(/ct0/);
    expect(() => parseCookieExport("{not json")).toThrow(/not valid JSON/);
    expect(() => parseCookieExport("{}")).toThrow(/array/);
  });
});

describe("xImportCookies", () => {
  it("adds cookies, closes the context and returns the checked state", async () => {
    const added: unknown[] = [];
    let closed = false;
    const state = await xImportCookies(buildXCookies(AUTH, CT0), {
      openContext: async () => ({
        addCookies: async (c) => void added.push(...c),
        close: async () => void (closed = true),
      }),
      verify: async () => "logged_in",
    });
    expect(state).toBe("logged_in");
    expect(added).toHaveLength(2);
    expect(closed).toBe(true);
  });
});
