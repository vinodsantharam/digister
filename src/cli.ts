import { Command } from "commander";

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
  yt.command("import").description("Import channels").action(notImplemented);
  yt.command("check").description("Show the newest video per channel").action(notImplemented);

  program.command("doctor").description("Check the setup").action(notImplemented);
  return program;
}

await buildProgram().parseAsync(process.argv);
