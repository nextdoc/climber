import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import {
  appendHistory,
  AscentConfig,
  AscentDefaults,
  ascentDir,
  collectAndScore,
  git,
  REPO_ROOT,
  runDir,
  saveConfig,
  scoresByName
} from "./lib/ascent.ts";

type Options = { targetOrg: string; from: string; config: string };

new Command()
  .name("ascent-init")
  .description("Start an ascent: create its branch and worktree, then score the baseline")
  .argument("<name>", "ascent name, used for the branch ascent/<name> and the worktree")
  .requiredOption("-o, --target-org <org>", "org alias or username to deploy and test in")
  .option("--from <ref>", "commit the ascent starts from", "HEAD")
  .option("-c, --config <file>", "ascent defaults to start from", join(REPO_ROOT, "ascent.config.json"))
  .action((name: string, opts: Options) => {
    if (existsSync(ascentDir(name))) throw new Error(`Ascent ${name} already exists at ${ascentDir(name)}`);
    const branch = `ascent/${name}`;
    const worktree = join(REPO_ROOT, "target/worktrees", name);
    const baseCommit = git(REPO_ROOT, "rev-parse", opts.from);
    const defaults = AscentDefaults.parse(JSON.parse(readFileSync(opts.config, "utf8")));
    const config = AscentConfig.parse({
      ...defaults,
      name,
      branch,
      worktree,
      targetOrg: opts.targetOrg,
      createdAt: new Date().toISOString(),
      baseCommit
    });
    const files = git(REPO_ROOT, "ls-tree", "-r", "--name-only", baseCommit, "--", "force-app").split("\n");
    const missing = [...config.testClasses.sample, ...config.testClasses.holdout].filter(
      (c) => !files.some((f) => f.endsWith(`/classes/${c}.cls`))
    );
    if (missing.length > 0) throw new Error(`Test classes not found at ${baseCommit}: ${missing.join(", ")}`);
    git(REPO_ROOT, "worktree", "add", "-b", branch, worktree, baseCommit);
    saveConfig(config);

    const folder = runDir(name, 0);
    mkdirSync(folder, { recursive: true });
    const result = collectAndScore(config, folder);
    if (result.gated) throw new Error(`Baseline is gated by ${result.gate}; fix it before starting an ascent`);
    appendHistory(name, {
      iteration: 0,
      at: new Date().toISOString(),
      outcome: "baseline",
      dryRun: false,
      scores: scoresByName(result),
      overall: result.overall,
      commit: baseCommit,
      run: folder
    });
    console.log(JSON.stringify({ ascent: name, branch, worktree, baseline: scoresByName(result), overall: result.overall }, null, 2));
  })
  .parse();
