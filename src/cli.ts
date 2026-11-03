import { Command, Option } from "commander";
import { TierSchema } from "./config.js";
import { loadChannels, loadDigisterConfig } from "./config.js";
import { fetchAllFeeds } from "./sources/youtube/rss.js";
import { ollamaHealthy } from "./llm/client.js";
import { xCheck, xLogin } from "./sources/x/browser.js";
import { importChannels } from "./sources/youtube/channels.js";

const notImplemented = () => {
  console.log("not implemented");
};

export function buildProgram(): Command {
  const program = new Command("digister").description(
    "Turn X and YouTube into a morning HTML digest, using Ollama.",
  );

  program
    .command("run")
    .description("Collect, score and write today's digest")
    .option("--dry", "fetch YouTube only, print counts, no LLM calls or writes")
    .action(notImplemented);

  const x = program.command("x").description("X source");
  x.command("login")
    .description("Log in to X once in a browser window")
    .action(async () => {
      try {
        if (await xLogin()) console.log("Logged in: session saved in the Digister profile.");
        else {
          console.error("No auth_token cookie found: login not completed. Run `digister x login` again.");
          process.exitCode = 1;
        }
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
      }
    });
  x.command("check")
    .description("Check the X session is still logged in")
    .action(async () => {
      try {
        const headless = loadDigisterConfig().x.headless;
        const state = await xCheck({ headless });
        console.log(
          state === "logged_in"
            ? "X: logged in"
            : state === "logged_out"
              ? "X: logged out (run `digister x login`)"
              : "X: blocked (challenge page or HTTP error); open the profile headed and resolve it",
        );
        if (state !== "logged_in") process.exitCode = 1;
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
      }
    });

  const yt = program.command("youtube").description("YouTube source");
  yt.command("import")
    .description("Add channels to channels.yaml from a Takeout CSV or one channel URL/@handle")
    .option("--takeout <csv>", "Google Takeout subscriptions.csv (added with tier normal)")
    .option("--url <channel>", "channel URL or @handle")
    .addOption(new Option("--tier <tier>", "tier for --url").choices(TierSchema.options).default("must"))
    .action(async (opts) => {
      try {
        const r = await importChannels(opts);
        for (const c of r.added) console.log(`added ${c.name} (${c.id})`);
        console.log(`${r.added.length} added, ${r.skipped} already present in ${r.file}`);
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
      }
    });
  yt.command("check")
    .description("Show the newest video per channel")
    .action(async () => {
      try {
        const { channels } = loadChannels();
        const { feeds, failed } = await fetchAllFeeds(channels);
        for (const { channel, entries } of feeds) {
          const newest = [...entries].sort((a, b) => b.published_at.localeCompare(a.published_at))[0];
          console.log(
            newest
              ? `${channel.name}: ${newest.title} (${newest.published_at.slice(0, 10)}) ${newest.url}`
              : `${channel.name}: no videos`,
          );
        }
        for (const name of failed) console.log(`${name}: FAILED`);
        if (failed.length > 0) process.exitCode = 1;
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
      }
    });

  program
    .command("doctor")
    .description("Check the setup")
    .action(async () => {
      const s = await ollamaHealthy().catch((err: Error) => ({ ok: false, model: "?", error: err.message }) as const);
      console.log(`Ollama: ${s.ok ? "ok" : "PROBLEM"}, model ${s.model}${s.error ? ` (${s.error})` : ""}`);
      if (!s.ok) process.exitCode = 1;
    });
  return program;
}

await buildProgram().parseAsync(process.argv);
