import { Command, Option } from "commander";
import { TierSchema } from "./config.js";
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
  x.command("login").description("Log in to X once in a browser window").action(notImplemented);
  x.command("check").description("Check the X session is still logged in").action(notImplemented);

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
  yt.command("check").description("Show the newest video per channel").action(notImplemented);

  program.command("doctor").description("Check the setup").action(notImplemented);
  return program;
}

await buildProgram().parseAsync(process.argv);
