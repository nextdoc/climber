import { Command } from "commander";
import { scoreRun, type ScoreOptions } from "./lib/scoring.ts";

new Command()
  .name("score")
  .description("Score a run folder written by cli/score-prepare.sh, 0 to 100 per dimension, as defined in doc/scoring.md")
  .requiredOption("-a, --app <globs...>", "application Apex file globs")
  .requiredOption("-t, --test <globs...>", "test Apex file globs (removed from the application set)")
  .option("-r, --run <dir>", "run folder", "target/tmp/score")
  .option("--root <dir>", "project folder the globs and analyzer paths are relative to", ".")
  .action((opts: ScoreOptions) => {
    console.log(JSON.stringify(scoreRun(opts), null, 2));
  })
  .parse();
