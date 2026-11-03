import { describe, expect, it } from "vitest";
import { detectXState } from "../src/sources/x/browser.js";

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
