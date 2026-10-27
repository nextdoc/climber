import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import {
  AscentDefaults,
  ascentDir,
  collectAndScore,
  git,
  kept,
  loadConfig,
  loadHistory,
  REPO_ROOT,
  scoresByName
} from "./lib/ascent.ts";

type Options = { baseline: boolean };

new Command()
  .name("confirm")
  .description(
    "Deploy and test an ascent's start and best kept commits in deploy mode with every default weight, to confirm a streamline ascent before merging. Leaves the best kept code deployed."
  )
  .argument("<name>", "ascent name")
  .option("--no-baseline", "score only the best kept commit")
  .action(async (name: string, opts: Options) => {
    const config = loadConfig(name);
    if (git(config.worktree, "status", "--porcelain") !== "") {
      throw new Error(`Worktree ${config.worktree} is not clean; commit or restore it first`);
    }
    const defaults = AscentDefaults.parse(JSON.parse(readFileSync(join(REPO_ROOT, "ascent.config.json"), "utf8")));
    const deploy = { ...config, mode: "deploy" as const, weights: defaults.weights };
    const states = kept(loadHistory(name));
    const targets = [...(opts.baseline ? [["baseline", states[0]] as const] : []), ["best", states.at(-1)!] as const];

    const results: Record<string, unknown> = {};
    try {
      for (const [label, entry] of targets) {
        git(config.worktree, "checkout", "-q", "--detach", entry.commit!);
        const result = await collectAndScore(deploy, join(ascentDir(name), "confirm", label));
        results[label] = {
          iteration: entry.iteration,
          commit: entry.commit,
          ascentOverall: entry.overall,
          gated: result.gated,
          gateDetail: result.gateDetail,
          overall: result.overall,
          scores: scoresByName(result)
        };
      }
    } finally {
      git(config.worktree, "checkout", "-q", config.branch);
    }
    const best = results.best as { gated: boolean; scores: Record<string, number> };
    const confirmed = !best.gated && best.scores["Tests passing"] === 100;
    const out = { at: new Date().toISOString(), confirmed, weights: defaults.weights, ...results };
    writeFileSync(join(ascentDir(name), "confirm.json"), JSON.stringify(out, null, 2) + "\n");
    console.log(JSON.stringify(out, null, 2));
    if (!confirmed) process.exitCode = 1;
  })
  .parseAsync();
