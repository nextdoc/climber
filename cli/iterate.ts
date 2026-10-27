import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import { z } from "zod";
import {
  appendHistory,
  ascentDir,
  bestScores,
  ClaudeResult,
  classFiles,
  collectAndScore,
  consecutiveDiscards,
  decide,
  editableFiles,
  formatApp,
  git,
  kept,
  lastJson,
  loadConfig,
  loadHistory,
  MCP_CONFIG,
  run,
  runDir,
  scoreOptions,
  scoresByName,
  type AscentConfig,
  type HistoryEntry,
  type Step
} from "./lib/ascent.ts";
import { writeReport } from "./lib/report.ts";
import { enabledDimensions, findings, scoreRun } from "./lib/scoring.ts";

type Options = { dryRun: boolean };

const Plan = z.object({
  reason: z.string().min(1),
  focus: z.array(z.string()),
  edits: z.array(z.string()).default([]),
  probes: z.array(z.string()).optional()
});

const MAX_PROBES = 5;

const STREAMLINE_TOOLS = ["loadAccessToken", "runAndRollback", "getFilteredOrgData"].map((t) => `mcp__streamline__${t}`);

const Learning = z.object({ learning: z.string().min(1) });

function summariseHistory(history: HistoryEntry[]): string {
  return history
    .filter((e) => !e.dryRun)
    .slice(-10)
    .map((e) => {
      const plan = e.focus ? ` focus=${e.focus.join(", ")}: ${e.reason}` : "";
      const decision = e.decision ? ` (${e.decision.join("; ")})` : "";
      const learning = e.learning ? `\n  learning: ${e.learning}` : "";
      return `#${e.iteration} ${e.outcome} overall=${e.overall ?? "-"}${plan}${decision}${learning}`;
    })
    .join("\n");
}

function planPrompt(config: AscentConfig, history: HistoryEntry[], editable: Set<string>): string {
  const current = kept(history).at(-1)!;
  const options = scoreOptions(config, current.run!);
  return `You are the plan step of one iteration of an ascent that improves Salesforce Apex code by hill climbing.

Plan one candidate: 1 to 6 related edits aimed at one weakness. Read the code, but do not edit any file.
A separate implement step will make your edits, in only these files:
${[...editable].filter((f) => f.endsWith(".cls")).join("\n")}
Tests and fixtures cannot change. The tests define the required behaviour, so the change must keep every test passing.

Dimensions, each scored 0 to 100 (higher is better): ${enabledDimensions(config.weights).join(", ")}.
A candidate is kept when every focus dimension rises by more than its margin and no other dimension falls by more than its margin.
Margins: ${JSON.stringify(config.margins)}

Current scores and details:
${JSON.stringify(scoreRun(options).dimensions, null, 1)}

Static analysis findings in application files:
${findings(options).join("\n")}

Recent iterations and their learnings (do not repeat a discarded change):
${summariseHistory(history)}
${config.plannerStreamline ? probeInstructions(config) : ""}
End your reply with one JSON object and nothing after it. Write each edit precisely enough to implement without your reasoning:
{"reason": "the weakness and why this fixes it", "focus": ["dimension names this should raise"], "edits": ["one line per edit"]${config.plannerStreamline ? ', "probes": ["one line per probe: the question and what it showed"]' : ""}}
`;
}

function probeInstructions(config: AscentConfig): string {
  return `
Probes: you may run up to ${MAX_PROBES} small anonymous Apex scripts with Streamline (runAndRollback, orgAlias "${config.targetOrg}") to answer questions before you plan, such as whether an approach compiles, what a query returns, or how much CPU or how many queries an approach uses. The org is rolled back after each one.
- Test only the isolated change: a query, an expression or a small method, with the few records it needs. Do not copy whole classes into a probe, and do not call the org's application classes, which may not match the worktree.
- Do not run the test classes or reproduce their scenarios, and do not read test class bodies from the org.
- Probes do not decide anything. The harness scores your candidate after the implement step, and only that score decides keep or discard.
`;
}

function implementPrompt(plan: z.infer<typeof Plan>, editable: Set<string>): string {
  return `You are the implement step of one iteration of an ascent that improves Salesforce Apex code by hill climbing.

Make exactly these edits, and nothing else:
${plan.edits.map((e) => `- ${e}`).join("\n")}

Why: ${plan.reason}

Edit only these files:
${[...editable].filter((f) => f.endsWith(".cls")).join("\n")}
Do not edit tests or fixtures, deploy, or run tests. The harness deploys, tests and scores your change.
The tests define the required behaviour, so the change must keep every test passing.
`;
}

function learnPrompt(entry: HistoryEntry, deltas: Record<string, number> | undefined, patch: string): string {
  return `You are the learn step of one iteration of an ascent that improves Salesforce Apex code by hill climbing.
Later plan steps read your learning before choosing their next candidate.

Plan: ${JSON.stringify({ reason: entry.reason, focus: entry.focus, edits: entry.edits })}
Outcome: ${entry.outcome}
Decision: ${(entry.decision ?? []).join("; ")}
Score changes against the current kept state: ${JSON.stringify(deltas ?? {})}

Diff:
${patch}

Write one learning: what this result shows about which changes move which dimensions, and why. Do not restate the scores.
End your reply with one JSON object and nothing after it:
{"learning": "one or two sentences"}
`;
}

function runStep(
  config: AscentConfig,
  folder: string,
  name: "plan" | "implement" | "learn",
  prompt: string,
  entry: HistoryEntry
): string {
  const step: Step = config.steps[name];
  writeFileSync(join(folder, `${name}-prompt.md`), prompt);
  const started = Date.now();
  const command =
    name === "plan" && config.plannerStreamline
      ? `${step.command} --mcp-config '${MCP_CONFIG}' --allowedTools ${STREAMLINE_TOOLS.join(",")}`
      : step.command;
  const result = run("sh", ["-c", command], config.worktree, prompt, { MODEL: step.model });
  writeFileSync(join(folder, `${name}.txt`), result.stdout + result.stderr);
  let parsed: z.infer<typeof ClaudeResult> | undefined;
  try {
    parsed = ClaudeResult.parse(JSON.parse(result.stdout));
  } catch {
    // Plain text output, which carries no cost.
  }
  entry.steps = {
    ...entry.steps,
    [name]: { model: step.model, durationMs: Date.now() - started, costUsd: parsed?.total_cost_usd, turns: parsed?.num_turns }
  };
  if (result.status !== 0) throw new Error(`${name} step exited ${result.status}, see ${join(folder, `${name}.txt`)}`);
  return parsed?.result ?? result.stdout;
}

/** Appends the entry, or when it fails validation, a minimal error entry, keeping the full entry in the run folder. */
function record(name: string, folder: string, entry: HistoryEntry) {
  try {
    appendHistory(name, entry);
  } catch (error) {
    writeFileSync(join(folder, "entry.json"), JSON.stringify(entry, null, 2));
    const { iteration, at, finishedAt, dryRun, reason, patch, patchHash, steps } = entry;
    const decision = [`history entry invalid, see ${join(folder, "entry.json")}: ${(error as Error).message}`];
    Object.assign(entry, { outcome: "error", decision });
    appendHistory(name, { iteration, at, finishedAt, outcome: "error", dryRun, reason, patch, patchHash, run: folder, decision, steps });
  }
}

function restore(worktree: string) {
  git(worktree, "reset", "--hard", "HEAD");
  git(worktree, "clean", "-fd");
}

new Command()
  .name("iterate")
  .description("Run one iteration of an ascent: plan, implement, score, keep or discard, then learn")
  .argument("<name>", "ascent name")
  .option("--dry-run", "run every step, then restore the worktree instead of committing", false)
  .action(async (name: string, opts: Options) => {
    const config = loadConfig(name);
    const history = loadHistory(name);
    const iteration = Math.max(...history.map((e) => e.iteration)) + 1;
    const folder = runDir(name, iteration);
    mkdirSync(folder, { recursive: true });
    const entry: HistoryEntry = { iteration, at: new Date().toISOString(), outcome: "error", dryRun: opts.dryRun };

    if (git(config.worktree, "status", "--porcelain") !== "") {
      throw new Error(`Worktree ${config.worktree} is not clean; commit or restore it first`);
    }
    const editableBefore = editableFiles(config);
    const holdout = classFiles(config.worktree, config.testClasses.holdout);

    try {
      for (const file of holdout) rmSync(join(config.worktree, file));
      const plan = lastJson(runStep(config, folder, "plan", planPrompt(config, history, editableBefore), entry), Plan);
      Object.assign(entry, plan, { focus: plan.focus.filter((f) => enabledDimensions(config.weights).includes(f)) });
      if (entry.focus!.length === 0) throw new Error("Plan names no known focus dimension");
      if (plan.edits.length === 0) throw new Error("Plan names no edits");
      const planChanged = git(config.worktree, "status", "--porcelain")
        .split("\n")
        .filter((line) => line !== "" && !holdout.includes(line.slice(3)));
      if (planChanged.length > 0) throw new Error(`plan step changed files: ${planChanged.join(", ")}`);
      runStep(config, folder, "implement", implementPrompt(plan, editableBefore), entry);
      if (holdout.length > 0) git(config.worktree, "checkout", "HEAD", "--", ...holdout);
      formatApp(config);

      git(config.worktree, "add", "-A");
      const changed = git(config.worktree, "diff", "--cached", "--name-only").split("\n").filter(Boolean);
      if (changed.length === 0) {
        entry.outcome = "no-change";
      } else {
        const patch = git(config.worktree, "diff", "--cached", "--binary") + "\n";
        entry.patch = join(ascentDir(name), "patches", `${iteration}.patch`);
        entry.patchHash = createHash("sha256").update(patch).digest("hex");
        mkdirSync(join(ascentDir(name), "patches"), { recursive: true });
        writeFileSync(entry.patch, patch);

        const editable = new Set([...editableBefore, ...editableFiles(config)]);
        const forbidden = changed.filter((f) => !editable.has(f));
        const discarded = history.filter((e) => !e.dryRun && e.outcome !== "keep" && e.outcome !== "baseline");
        if (forbidden.length > 0) {
          entry.outcome = "rejected";
          entry.decision = [`edited files outside the application: ${forbidden.join(", ")}`];
        } else if (discarded.some((e) => e.patchHash === entry.patchHash)) {
          entry.outcome = "rejected";
          entry.decision = ["repeats a discarded change"];
        } else {
          const result = await collectAndScore(config, folder);
          const current = kept(history).at(-1)!.scores!;
          const decision = decide(current, bestScores(history), result, entry.focus, config.margins);
          Object.assign(entry, { outcome: decision.outcome, decision: decision.reasons, run: folder });
          if (result.dimensions) entry.scores = scoresByName(result);
          entry.overall = result.overall;
        }
      }

      if (entry.outcome === "keep" && !opts.dryRun) {
        git(config.worktree, "commit", "-q", "-m", `ASCENT ${name} #${iteration} ${entry.reason}`);
        entry.commit = git(config.worktree, "rev-parse", "HEAD");
      } else {
        restore(config.worktree);
      }
    } catch (error) {
      entry.outcome = "error";
      entry.decision = [(error as Error).message];
      writeFileSync(join(folder, "error.txt"), (error as Error).stack ?? String(error));
      restore(config.worktree);
    }

    const previous = kept(history).at(-1)!.scores!;
    const deltas = entry.scores
      ? Object.fromEntries(Object.entries(entry.scores).map(([d, score]) => [d, Number((score! - previous[d]!).toFixed(1))]))
      : undefined;
    if (entry.outcome === "keep" || entry.outcome === "discard" || entry.outcome === "gated") {
      try {
        const patch = readFileSync(entry.patch!, "utf8");
        entry.learning = lastJson(runStep(config, folder, "learn", learnPrompt(entry, deltas, patch), entry), Learning).learning;
      } catch (error) {
        entry.decision = [...(entry.decision ?? []), `learn step failed: ${(error as Error).message}`];
      }
    }

    entry.finishedAt = new Date().toISOString();
    record(name, folder, entry);
    try {
      writeReport(name);
    } catch (error) {
      console.error(`report not written: ${(error as Error).message}`);
    }
    const all = [...history, entry];
    const discards = consecutiveDiscards(all);
    console.log(
      JSON.stringify(
        {
          iteration,
          dryRun: opts.dryRun,
          outcome: entry.outcome,
          focus: entry.focus,
          reason: entry.reason,
          decision: entry.decision,
          learning: entry.learning,
          overall: entry.overall,
          deltas,
          consecutiveDiscards: discards,
          stop: discards >= config.maxDiscards,
          report: join(ascentDir(name), "report.html")
        },
        null,
        2
      )
    );
  })
  .parseAsync();
