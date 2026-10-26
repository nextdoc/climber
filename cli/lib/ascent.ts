import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, globSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { DIMENSION_NAMES, scoreRun, type ScoreResult } from "./scoring.ts";

const Dimension = z.enum(DIMENSION_NAMES as [string, ...string[]]);

/** One number for every dimension, keyed by dimension name. */
const ByDimension = z.record(Dimension, z.number());

/** An agent CLI invocation. The command reads the prompt on stdin, runs in the worktree, and gets the model as $MODEL. */
const Step = z.strictObject({
  model: z.string().min(1),
  command: z.string().min(1)
});

export type Step = z.infer<typeof Step>;

export const AscentConfig = z.strictObject({
  name: z.string().min(1),
  branch: z.string().min(1),
  worktree: z.string().min(1),
  targetOrg: z.string().min(1),
  createdAt: z.iso.datetime(),
  baseCommit: z.string().regex(/^[0-9a-f]{40}$/),
  app: z.array(z.string()).min(1),
  test: z.array(z.string()),
  testClasses: z
    .strictObject({
      sample: z.array(z.string().min(1)).min(1),
      holdout: z.array(z.string().min(1))
    })
    .refine((t) => !t.holdout.some((c) => t.sample.includes(c)), "A test class cannot be in both sample and holdout"),
  steps: z.strictObject({ plan: Step, implement: Step, learn: Step }),
  maxDiscards: z.int().positive(),
  margins: ByDimension
});

export type AscentConfig = z.infer<typeof AscentConfig>;

/** The committed ascent.config.json: an ascent config without the fields that belong to one ascent. */
export const AscentDefaults = AscentConfig.omit({
  name: true,
  branch: true,
  worktree: true,
  targetOrg: true,
  createdAt: true,
  baseCommit: true
});

/** What one agent step used. Cost is the agent CLI estimate at list price, when it reports one. */
const StepUsage = z.strictObject({
  model: z.string().min(1),
  durationMs: z.int().nonnegative(),
  costUsd: z.number().nonnegative().optional(),
  turns: z.int().nonnegative().optional()
});

export type StepUsage = z.infer<typeof StepUsage>;

export const Outcome = z.enum(["baseline", "keep", "discard", "gated", "rejected", "no-change", "error"]);

export type Outcome = z.infer<typeof Outcome>;

export const HistoryEntry = z.strictObject({
  iteration: z.int().nonnegative(),
  at: z.iso.datetime(),
  finishedAt: z.iso.datetime().optional(),
  outcome: Outcome,
  dryRun: z.boolean(),
  reason: z.string().optional(),
  focus: z.array(Dimension).optional(),
  edits: z.array(z.string()).optional(),
  decision: z.array(z.string()).optional(),
  learning: z.string().optional(),
  scores: ByDimension.optional(),
  overall: z.number().optional(),
  commit: z.string().optional(),
  patch: z.string().optional(),
  patchHash: z.string().optional(),
  run: z.string().optional(),
  steps: z.strictObject({ plan: StepUsage.optional(), implement: StepUsage.optional(), learn: StepUsage.optional() }).optional()
});

export type HistoryEntry = z.infer<typeof HistoryEntry>;

export const REPO_ROOT = resolve(import.meta.dirname, "../..");

export const ASCENTS_DIR = join(REPO_ROOT, "target/ascents");

export const ascentDir = (name: string) => join(ASCENTS_DIR, name);

export const runDir = (name: string, iteration: number) => join(ascentDir(name), "runs", String(iteration));

export function loadConfig(name: string): AscentConfig {
  return AscentConfig.parse(JSON.parse(readFileSync(join(ascentDir(name), "ascent.json"), "utf8")));
}

export function saveConfig(config: AscentConfig) {
  mkdirSync(ascentDir(config.name), { recursive: true });
  writeFileSync(join(ascentDir(config.name), "ascent.json"), JSON.stringify(AscentConfig.parse(config), null, 2) + "\n");
}

export function loadHistory(name: string): HistoryEntry[] {
  const file = join(ascentDir(name), "history.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => HistoryEntry.parse(JSON.parse(line)));
}

export function appendHistory(name: string, entry: HistoryEntry) {
  appendFileSync(join(ascentDir(name), "history.jsonl"), JSON.stringify(HistoryEntry.parse(entry)) + "\n");
}

/** Source files of the given Apex classes, with their meta files. */
export function classFiles(worktree: string, classes: string[]): string[] {
  return classes.flatMap((c) => globSync(`force-app/**/classes/${c}.cls`, { cwd: worktree }).flatMap((f) => [f, `${f}-meta.xml`]));
}

export function run(command: string, args: string[], cwd: string, input?: string, env?: Record<string, string>) {
  const result = spawnSync(command, args, {
    cwd,
    input,
    env: { ...process.env, ...env },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024
  });
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

export function git(cwd: string, ...args: string[]): string {
  const result = run("git", args, cwd);
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

/** Application files and their metadata, relative to the worktree. */
export function editableFiles(config: AscentConfig): Set<string> {
  const glob = (patterns: string[]) => new Set(patterns.flatMap((p) => globSync(p, { cwd: config.worktree })));
  const tests = glob(config.test).union(new Set(classFiles(config.worktree, config.testClasses.holdout)));
  const apps = [...glob(config.app)].filter((f) => !tests.has(f));
  return new Set(apps.flatMap((f) => [f, `${f}-meta.xml`]));
}

/** Formats the application classes with Prettier, so line coverage cannot be gamed by packing statements onto one line. */
export function formatApp(config: AscentConfig) {
  const files = [...editableFiles(config)].filter((f) => f.endsWith(".cls") && existsSync(join(config.worktree, f)));
  if (files.length === 0) return;
  // The worktree sits under target/, which .gitignore excludes, and Prettier honours .gitignore by default.
  const result = run(join(REPO_ROOT, "node_modules/.bin/prettier"), ["--write", "--ignore-path=", ...files], config.worktree);
  if (result.status !== 0) throw new Error(`prettier failed: ${result.stderr.trim()}`);
}

/** Deploys, analyses and tests the worktree into the run folder, then scores it. */
export function collectAndScore(config: AscentConfig, folder: string): ScoreResult {
  const prepare = join(REPO_ROOT, "cli/score-prepare.sh");
  const classes = [...config.testClasses.sample, ...config.testClasses.holdout].join(",");
  const result = run(prepare, [config.targetOrg, folder, classes], config.worktree);
  writeFileSync(join(folder, "prepare.log"), result.stdout + result.stderr);
  if (result.status !== 0) throw new Error(`score-prepare failed, see ${join(folder, "prepare.log")}`);
  return scoreRun({ app: config.app, test: config.test, run: folder, root: config.worktree });
}

export function scoresByName(result: ScoreResult): Record<string, number> {
  return Object.fromEntries((result.dimensions ?? []).map((d) => [d.name, d.score]));
}

/** Entries that define the current state of the ascent: the baseline and every kept candidate. */
export const kept = (history: HistoryEntry[]) =>
  history.filter((e) => !e.dryRun && (e.outcome === "baseline" || e.outcome === "keep"));

export function bestScores(history: HistoryEntry[]): Record<string, number> {
  const best: Record<string, number> = {};
  for (const entry of kept(history)) {
    for (const [name, score] of Object.entries(entry.scores ?? {})) best[name] = Math.max(best[name] ?? 0, score);
  }
  return best;
}

export function consecutiveDiscards(history: HistoryEntry[]): number {
  let count = 0;
  for (const entry of history.filter((e) => !e.dryRun).reverse()) {
    if (entry.outcome === "keep" || entry.outcome === "baseline") break;
    count++;
  }
  return count;
}

/**
 * The keep rule from doc/design.md: every focus dimension rises by more than its margin, no other dimension
 * falls by more than its margin, and no dimension drops below half its best score.
 */
export function decide(
  current: Record<string, number>,
  best: Record<string, number>,
  candidate: ScoreResult,
  focus: string[],
  margins: Record<string, number>
): { outcome: "keep" | "discard" | "gated"; reasons: string[] } {
  if (candidate.gated) return { outcome: "gated", reasons: [`gated by ${candidate.gate}`] };
  const scores = scoresByName(candidate);
  const reasons: string[] = [];
  for (const name of DIMENSION_NAMES) {
    const delta = scores[name] - current[name];
    const margin = margins[name] ?? 0;
    if (focus.includes(name) && !(delta > margin)) {
      reasons.push(`${name} is a focus but rose ${delta.toFixed(1)}, not more than its margin ${margin}`);
    }
    if (!focus.includes(name) && delta < -margin) {
      reasons.push(`${name} fell ${(-delta).toFixed(1)}, more than its margin ${margin}`);
    }
    if (scores[name] < (best[name] ?? 0) / 2) {
      reasons.push(`${name} at ${scores[name]} is below half its best ${best[name]}`);
    }
  }
  return reasons.length === 0
    ? { outcome: "keep", reasons: ["every focus dimension rose and nothing else fell"] }
    : { outcome: "discard", reasons };
}
