import { Command, Option } from "commander";
import { TierSchema } from "./config.js";
import { loadChannels, loadDigisterConfig } from "./config.js";
import { fetchAllFeeds } from "./sources/youtube/rss.js";
import { formatChecks, runDoctor } from "./doctor.js";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { buildXCookies, parseCookieExport, xCheck, xImportCookies, xLogin } from "./sources/x/browser.js";
import { sendDigestEmail } from "./deliver/email.js";
import { runPipeline } from "./pipeline/run.js";
import { importChannels } from "./sources/youtube/channels.js";
import { runSetup, terminalIO } from "./setup.js";

export function buildProgram(): Command {
  const program = new Command("digister").description(
    "Turn X and YouTube into a morning HTML digest, using Ollama.",
  );

  program
    .command("run")
    .description("Collect, score and write today's digest")
    .option("--dry", "fetch YouTube only, print counts, no LLM calls or writes")
    .action(async (opts: { dry?: boolean }) => {
      const r = await runPipeline({ dry: opts.dry });
      process.exitCode = r.exitCode;
    });

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
  x.command("import-cookies")
    .description("Copy your X session (auth_token, ct0) from your normal browser")
    .option("--file <path>", "Cookie-Editor JSON export instead of pasting values")
    .action(async (opts: { file?: string }) => {
      try {
        let cookies;
        if (opts.file) {
          cookies = parseCookieExport(readFileSync(opts.file, "utf8"));
        } else {
          console.log("In your normal browser: open x.com, DevTools > Application > Cookies > https://x.com");
          const rl = createInterface({ input: process.stdin, output: process.stdout });
          try {
            const auth = await rl.question("auth_token value: ");
            const ct0 = await rl.question("ct0 value: ");
            cookies = buildXCookies(auth, ct0);
          } finally {
            rl.close();
          }
        }
        const state = await xImportCookies(cookies);
        console.log(
          state === "logged_in"
            ? "X: logged in (session saved in the Digister profile)"
            : state === "logged_out"
              ? "X: cookies saved but X says logged out; copy fresh values while logged in and try again"
              : "X: blocked (challenge page or HTTP error); open x.com in your browser and resolve it",
        );
        if (state !== "logged_in") process.exitCode = 1;
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

  const email = program.command("email").description("Email delivery");
  email
    .command("test")
    .description("Send a short test email with the configured SMTP settings")
    .action(async () => {
      try {
        const cfg = loadDigisterConfig().email;
        if (!cfg.to) throw new Error("email.to is empty in digister.yaml");
        await sendDigestEmail(
          {
            subject: "Digister test email",
            html: "<p>Digister can send you email. Your morning digest will arrive like this.</p>",
            text: "Digister can send you email. Your morning digest will arrive like this.",
          },
          cfg,
        );
        console.log(`Test email sent to ${cfg.to}${cfg.enabled ? "" : " (set email.enabled: true to get the daily digest)"}`);
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
    .command("setup")
    .description("Interactive first-time setup: config files, output folder, X List")
    .action(async () => {
      const io = terminalIO();
      try {
        await runSetup({ io });
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
      } finally {
        io.close();
      }
    });

  program
    .command("doctor")
    .description("Check the setup")
    .action(async () => {
      const checks = await runDoctor();
      console.log(formatChecks(checks));
      if (checks.some((c) => c.status === "fail")) process.exitCode = 1;
    });
  return program;
}

await buildProgram().parseAsync(process.argv);
