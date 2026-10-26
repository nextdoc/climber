import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Command } from "commander";
import {
  AscentDefaults,
  ascentDir,
  ClaudeResult,
  lastJson,
  loadConfig,
  loadHistory,
  REPO_ROOT,
  run
} from "./lib/ascent.ts";
import { writeReport } from "./lib/report.ts";
import { RetroReply, retroInputs, retroPrompt, withCodes } from "./lib/retro.ts";

type Options = { spec: string[] };

new Command()
  .name("retro")
  .description("Write a first-pass retrospective of an ascent: behaviour changes, code patterns and test gaps")
  .argument("<name>", "ascent name")
  .option("-s, --spec <files...>", "requirement documents the code should meet", [])
  .action((name: string, opts: Options) => {
    const config = loadConfig(name);
    const defaults = AscentDefaults.parse(JSON.parse(readFileSync(join(REPO_ROOT, "ascent.config.json"), "utf8")));
    const step = config.steps.retro ?? defaults.steps.retro;
    if (!step) throw new Error("No retro step in the ascent config or ascent.config.json");

    const folder = join(ascentDir(name), "retro");
    mkdirSync(folder, { recursive: true });
    const inputs = retroInputs(config, loadHistory(name), opts.spec.map((s) => resolve(s)));
    const prompt = retroPrompt(inputs);
    writeFileSync(join(folder, "prompt.md"), prompt);

    const started = Date.now();
    const result = run("sh", ["-c", step.command], config.worktree, prompt, { MODEL: step.model });
    writeFileSync(join(folder, "agent.txt"), result.stdout + result.stderr);
    if (result.status !== 0) throw new Error(`retro step exited ${result.status}, see ${join(folder, "agent.txt")}`);
    let parsed: ClaudeResult | undefined;
    try {
      parsed = ClaudeResult.parse(JSON.parse(result.stdout));
    } catch {
      // Plain text output, which carries no cost.
    }
    const reply = lastJson(parsed?.result ?? result.stdout, RetroReply);

    const retro = {
      ascent: name,
      at: new Date().toISOString(),
      base: inputs.base,
      head: inputs.head,
      changedTests: inputs.changedTests,
      step: { model: step.model, durationMs: Date.now() - started, costUsd: parsed?.total_cost_usd },
      ...withCodes(reply)
    };
    writeFileSync(join(ascentDir(name), "retro.json"), JSON.stringify(retro, null, 2) + "\n");
    writeReport(name);
    console.log(JSON.stringify({ retro: join(ascentDir(name), "retro.json"), summary: retro.summary }, null, 2));
  })
  .parse();
