import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  addChannels, extractChannel, importChannels, parseTakeoutCsv, resolveChannel,
} from "../src/sources/youtube/channels.js";

const fx = (n: string) => path.resolve("test/fixtures", n);
const tmp = () => mkdtempSync(path.join(tmpdir(), "digister-ch-"));

const START = `# my channels
channels:
  # the ones I never miss
  - id: "UCswG6FSbgZjbWtdf_hMLaow"
    name: "Matt Pocock"
    tier: must
`;

describe("takeout import", () => {
  it("parses quoted titles and skips junk", () => {
    const rows = parseTakeoutCsv(readFileSync(fx("takeout-subscriptions.csv"), "utf8"));
    expect(rows.map((r) => r.name)).toEqual([
      "Fireship", "Traversy Media, Inc.", "Linus Tech Tips", "Traversy Media, Inc.",
    ]);
  });

  it("adds missing channels as normal without duplicates, keeping comments and tiers", async () => {
    const file = path.join(tmp(), "channels.yaml");
    writeFileSync(file, START);
    const r = await importChannels({ takeout: fx("takeout-subscriptions.csv"), tier: "must", file });
    expect(r.added.map((c) => c.id)).toEqual([
      "UCsBjURrPoezykLs9EqgamOA", "UC29ju8bIPH5as8OGnQzwJyA", "UCXuqSBlHAE6Xw-yeJA0Tunw",
    ]);
    const text = readFileSync(file, "utf8");
    expect(text).toContain("# my channels");
    expect(text).toContain("# the ones I never miss");
    expect(text.match(/UCsBjURrPoezykLs9EqgamOA/g)).toHaveLength(1);
    expect(text).toMatch(/Traversy Media, Inc\./);
    // second import adds nothing and leaves the file alone
    const again = await importChannels({ takeout: fx("takeout-subscriptions.csv"), tier: "must", file });
    expect(again.added).toHaveLength(0);
    expect(readFileSync(file, "utf8")).toBe(text);
  });

  it("never re-tiers an existing channel", () => {
    const file = path.join(tmp(), "channels.yaml");
    writeFileSync(file, START);
    expect(addChannels(file, [{ id: "UCswG6FSbgZjbWtdf_hMLaow", name: "x" }], "normal")).toEqual([]);
    expect(readFileSync(file, "utf8")).toBe(START);
  });

  it("creates the file when missing", () => {
    const file = path.join(tmp(), "sub", "channels.yaml");
    addChannels(file, [{ id: "UCsBjURrPoezykLs9EqgamOA", name: "Fireship" }], "must");
    expect(readFileSync(file, "utf8")).toContain("tier: must");
  });
});

describe("channel page", () => {
  const html = readFileSync(fx("channel-page.html"), "utf8");

  it("extracts id and name", () => {
    expect(extractChannel(html)).toEqual({ id: "UCsBjURrPoezykLs9EqgamOA", name: "Fireship" });
  });

  it("falls back to the channelId JSON", () => {
    const json = '<script>var x={"channelId":"UCswG6FSbgZjbWtdf_hMLaow"}</script>';
    expect(extractChannel(json)?.id).toBe("UCswG6FSbgZjbWtdf_hMLaow");
    expect(extractChannel("<html></html>")).toBeNull();
  });

  it("resolves an @handle through an injected fetch and adds it with the given tier", async () => {
    const seen: string[] = [];
    const fetchFn = (async (url: string) => {
      seen.push(url);
      return new Response(html, { status: 200 });
    }) as unknown as typeof fetch;
    expect((await resolveChannel("@Fireship", fetchFn)).id).toBe("UCsBjURrPoezykLs9EqgamOA");
    expect(seen[0]).toBe("https://www.youtube.com/@Fireship");

    const file = path.join(tmp(), "channels.yaml");
    copyFileSync(path.resolve("config/channels.example.yaml"), file);
    const r = await importChannels({ url: "@Fireship", tier: "high", file, fetchFn });
    expect(r.added).toHaveLength(0); // already in the example file
    const empty = path.join(tmp(), "c.yaml");
    await importChannels({ url: "@Fireship", tier: "high", file: empty, fetchFn });
    expect(readFileSync(empty, "utf8")).toContain("tier: high");
  });

  it("reports HTTP errors", async () => {
    const fetchFn = (async () => new Response("", { status: 404 })) as unknown as typeof fetch;
    await expect(resolveChannel("@nope", fetchFn)).rejects.toThrow(/404/);
  });
});
