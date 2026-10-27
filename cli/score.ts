import { Command } from "commander";
import { scoreRun, type ScoreOptions } from "./lib/scoring.ts";

new Command()
  .name("score")
  .description("Score a run folder written by cli/score-prepare.sh, 0 to 100 per dimension, as defined in doc/scoring.md")
  .requiredOption("-a, --app <globs...>", "application Apex file globs")
  .requiredOption("-t, --test <globs...>", "test Apex file globs (removed from the application set)")
  .requiredOption("--headroom-test <test>", "test whose limit use scores limit headroom, e.g. AccountHealthRollupTest.headroomAt200Accounts")
  .option("-r, --run <dir>", "run folder", "target/tmp/score")
  .option("--root <dir>", "project folder the globs and analyzer paths are relative to", ".")
  .option("-w, --weights <json>", 'weight per dimension, 0 disables it, e.g. \'{"Graph Engine": 0}\'', JSON.parse, {})
  .option("-m, --mode <mode>", "deploy reads deploy.json, tests.json and test logs; streamline reads streamline.json and script logs", "deploy")
  .option("--run-counts <json>", "in streamline mode, test runs each measured scenario stands for", JSON.parse, {})
  .action((opts: ScoreOptions) => {
    console.log(JSON.stringify(scoreRun(opts), null, 2));
  })
  .parse();
