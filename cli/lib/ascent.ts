import { spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, globSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { compose } from "./compose.ts";
import { ExtractError } from "./extract.ts";
import { DETERMINISTIC, DIMENSION_NAMES, HALF_SCORES, scoreRun, weightOf, type ScoreOptions, type ScoreResult } from "./scoring.ts";
import { runVariants } from "./streamline.ts";

export const REPO_ROOT = resolve(import.meta.dirname, "../..");

const Dimension = z.enum(DIMENSION_NAMES as [string, ...string[]]);

/** One number for every dimension, keyed by dimension name. */
const ByDimension = z.record(Dimension, z.number());

/** A number for some dimensions. Scores only hold enabled dimensions. */
const SomeDimensions = z.partialRecord(Dimension, z.number());

/** An agent CLI invocation. The command reads the prompt on stdin, runs in the worktree, and gets the model as $MODEL. */
const Step = z.strictObject({
  model: z.string().min(1),
  command: z.string().min(1)
});

export type Step = z.infer<typeof Step>;

/** Dimensions streamline mode cannot measure, because anonymous Apex reports neither coverage nor test run time. */
export const STREAMLINE_UNAVAILABLE = ["Code coverage", "Test run time"];

/** One suite of what streamline mode composes into one anonymous Apex script per variant. Paths are relative to the worktree. */
const StreamlineSuite = z.strictObject({
  /** Globs of the classes this suite climbs, by default every editable class it extracts. Verify routes findings by them. */
  app: z.array(z.string()).optional(),
  /** Globs of the classes to extract, application classes and test fixtures alike. */
  classes: z.array(z.string()).min(1),
  /** The scenario classes, which log TEST and LIMITS lines. */
  scenarios: z.string().min(1),
  /** The CODE section statement per variant, e.g. {"correctness": "new AccountHealthRollupTest().runCorrectness();"}. */
  variants: z.record(z.string().regex(/^[\w-]+$/), z.string().min(1)),
  /** How many test runs each measured scenario stands for in resource efficiency. */
  runCounts: z.record(z.string(), z.int().positive()).default({})
});

export type StreamlineSuite = z.infer<typeof StreamlineSuite>;

/** One suite per class under climb, so each script stays under the Streamline size limit. A single suite needs no list. */
const StreamlineConfig = z
  .preprocess((v) => (Array.isArray(v) ? v : [v]), z.array(StreamlineSuite).min(1))
  .refine((suites) => {
    const names = suites.flatMap((s) => Object.keys(s.variants));
    return new Set(names).size === names.length;
  }, "Variant names must be unique across streamline suites");

/** One test, or a list when several classes are climbed. */
const HeadroomTests = z.preprocess((v) => (typeof v === "string" ? [v] : v), z.array(z.string().min(1)).min(1));

const AscentFields = z.strictObject({
  name: z.string().min(1),
  /** The git repo whose classes the ascent climbs. The worktree is created from it. Records, prompts and tooling stay in REPO_ROOT. */
  repo: z.string().min(1).default(REPO_ROOT),
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
  steps: z.strictObject({ plan: Step, implement: Step, learn: Step, retro: Step.optional(), audit: Step.optional(), verify: Step.optional() }),
  maxDiscards: z.int().positive(),
  /** Stops the ascent after this many discards in a row whose focus dimensions all failed to rise by more than their margins. */
  plateauDiscards: z.int().positive().default(3),
  margins: ByDimension,
  weights: z.partialRecord(Dimension, z.number().nonnegative()).default({}),
  /** Overrides the default half-score penalty of the dimensions scored by one. Fixed per ascent, because scores from different values differ. */
  halfScores: z.partialRecord(z.enum(Object.keys(HALF_SCORES) as [string, ...string[]]), z.number().positive()).default({}),
  /** PMD rules left out of the PMD dimension, such as style rules a codebase deliberately does not follow. Fixed per ascent. */
  excludedPmdRules: z.array(z.string().min(1)).default([]),
  /** Lets the plan step run anonymous Apex probes with Streamline. Fixed per ascent so ascents with and without it can be compared. */
  plannerStreamline: z.boolean().default(false),
  /** How runs collect their inputs. Fixed per ascent, because scores from the two modes differ. */
  mode: z.enum(["deploy", "streamline"]).default("deploy"),
  /** The tests whose limit use scores limit headroom, each on its own. Resource efficiency leaves them out. */
  headroomTest: HeadroomTests,
  streamline: StreamlineConfig.optional(),
  /** Set by ascent-init: the repeated baseline scores of each nondeterministic dimension and the margin measured from them. */
  noise: z.partialRecord(Dimension, z.strictObject({ scores: z.array(z.number()), configured: z.number(), margin: z.number() })).optional()
});

export const AscentConfig = AscentFields.refine((c) => c.mode === "deploy" || c.streamline !== undefined, {
  message: "Streamline mode needs a streamline block"
}).refine((c) => c.mode === "deploy" || STREAMLINE_UNAVAILABLE.every((d) => weightOf(c.weights, d) === 0), {
  message: `Streamline mode needs weight 0 for ${STREAMLINE_UNAVAILABLE.join(" and ")}`
});

export type AscentConfig = z.infer<typeof AscentConfig>;

/** The committed ascent.config.json: an ascent config without the fields that belong to one ascent. */
export const AscentDefaults = AscentFields.omit({
  name: true,
  repo: true,
  branch: true,
  worktree: true,
  targetOrg: true,
  createdAt: true,
  baseCommit: true,
  noise: true
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
  probes: z.array(z.string()).optional(),
  decision: z.array(z.string()).optional(),
  flags: z.array(z.string()).optional(),
  learning: z.string().optional(),
  scores: SomeDimensions.optional(),
  overall: z.number().optional(),
  commit: z.string().optional(),
  patch: z.string().optional(),
  patchHash: z.string().optional(),
  run: z.string().optional(),
  steps: z.strictObject({ plan: StepUsage.optional(), implement: StepUsage.optional(), learn: StepUsage.optional() }).optional()
});

export type HistoryEntry = z.infer<typeof HistoryEntry>;

/** Holds the Streamline server. Gitignored, so worktrees lack it and the plan step is pointed at this one. */
export const MCP_CONFIG = join(REPO_ROOT, ".mcp.json");

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

const SfdxProject = z.object({ packageDirectories: z.array(z.object({ path: z.string() })).min(1) });

/** The repo's package directories, from its sfdx-project.json. */
export function packageDirs(root: string): string[] {
  const file = join(root, "sfdx-project.json");
  if (!existsSync(file)) throw new Error(`No sfdx-project.json in ${root}`);
  return SfdxProject.parse(JSON.parse(readFileSync(file, "utf8"))).packageDirectories.map((d) => d.path.replace(/\\/g, "/").replace(/\/$/, ""));
}

/** Source files of the given Apex classes, with their meta files. */
/** Lines of `git status --porcelain` output whose path is not in `ignore`. */
export function changedFiles(porcelain: string, ignore: string[]): string[] {
  return porcelain.split("\n").filter((line) => line !== "" && !ignore.includes(line.trim().replace(/^\S+\s+/, "")));
}

export function classFiles(worktree: string, classes: string[]): string[] {
  const dirs = packageDirs(worktree);
  return classes.flatMap((c) => globSync(dirs.map((d) => `${d}/**/classes/${c}.cls`), { cwd: worktree }).flatMap((f) => [f, `${f}-meta.xml`]));
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

/** Streamline runs agent-written code outside Apex tests, so it is only allowed against a scratch org. */
export function assertScratchOrg(org: string) {
  const result = run("sf", ["org", "list", "--json"], REPO_ROOT);
  const scratchOrgs: { alias?: string; username: string }[] = JSON.parse(result.stdout).result?.scratchOrgs ?? [];
  if (!scratchOrgs.some((o) => o.alias === org || o.username === org)) {
    throw new Error(`${org} is not a scratch org. Streamline is only allowed against scratch orgs.`);
  }
}

/** Parses the last JSON object in an agent's reply that matches the schema. */
export function lastJson<T>(output: string, schema: z.ZodType<T>): T {
  for (let i = output.lastIndexOf("{"); i >= 0; i = output.lastIndexOf("{", i - 1)) {
    try {
      const parsed = schema.safeParse(JSON.parse(output.slice(i, output.lastIndexOf("}") + 1)));
      if (parsed.success) return parsed.data;
    } catch {
      // Not a complete JSON object yet; widen to the previous brace.
    }
    if (i === 0) break;
  }
  throw new Error("Agent reply has no matching JSON object");
}

/** The JSON a `claude -p --output-format json` step prints. */
export const ClaudeResult = z.object({ result: z.string(), total_cost_usd: z.number(), num_turns: z.int() });

export type ClaudeResult = z.infer<typeof ClaudeResult>;

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
  // Our config carries the Apex plugin, which another repo's config may lack, and Prettier resolves plugins from its cwd.
  const args = ["--write", "--ignore-path=", `--config=${join(REPO_ROOT, ".prettierrc")}`, ...files.map((f) => join(config.worktree, f))];
  const result = run(join(REPO_ROOT, "node_modules/.bin/prettier"), args, REPO_ROOT);
  if (result.status !== 0) throw new Error(`prettier failed: ${result.stderr.trim()}`);
}

export function scoreOptions(config: AscentConfig, folder: string): ScoreOptions {
  return {
    app: config.app,
    test: config.test,
    run: folder,
    root: config.worktree,
    weights: config.weights,
    halfScores: config.halfScores,
    mode: config.mode,
    headroomTest: config.headroomTest,
    runCounts: Object.assign({}, ...(config.streamline ?? []).map((s) => s.runCounts))
  };
}

/** A Code Analyzer rule selector for every rule in pmdRules except the excluded ones. */
export function pmdSelector(pmdRules: string[], excluded: string[]): string {
  const unknown = excluded.filter((r) => !pmdRules.includes(r));
  if (unknown.length > 0) throw new Error(`Unknown PMD rules in excludedPmdRules: ${unknown.join(", ")}`);
  return excluded.length === 0 ? "pmd" : `pmd:(${pmdRules.filter((r) => !excluded.includes(r)).join(",")})`;
}

/** Lists the PMD rules once per runs folder, since score-prepare empties each run folder. */
function pmdRuleSelector(config: AscentConfig, folder: string): string {
  if (config.excludedPmdRules.length === 0) return "pmd";
  const out = join(folder, "..", "pmd-rules.json");
  if (!existsSync(out)) {
    mkdirSync(join(folder, ".."), { recursive: true });
    const result = run("sf", ["code-analyzer", "rules", "--rule-selector", "pmd", "--output-file", out], config.worktree);
    if (result.status !== 0) throw new Error(`sf code-analyzer rules failed: ${result.stderr}`);
  }
  const rules: { name: string }[] = JSON.parse(readFileSync(out, "utf8")).rules;
  return pmdSelector(rules.map((r) => r.name), config.excludedPmdRules);
}

const TEST_DIMENSIONS = ["Tests passing", "Code coverage", "Test run time", "Limit headroom", "Resource efficiency"];

/**
 * Collects the run folder inputs, then scores them. Deploy mode deploys, analyses and runs the Apex tests.
 * Streamline mode analyses without deploying, then runs the composed variant scripts with Streamline.
 * With reuseAnalysisFrom, it only re-runs the tests of the code already in the org, copying the deploy and analyser output from that folder.
 */
export async function collectAndScore(config: AscentConfig, folder: string, reuseAnalysisFrom?: string): Promise<ScoreResult> {
  const streamline = config.mode === "streamline";
  const reuse = reuseAnalysisFrom !== undefined;
  const prepare = join(REPO_ROOT, "cli/score-prepare.sh");
  const classes = [...config.testClasses.sample, ...config.testClasses.holdout].join(",");
  const off = (...names: string[]) => (names.every((n) => weightOf(config.weights, n) === 0) ? "1" : "");
  const appClasses = [...editableFiles(config)].filter((f) => f.endsWith(".cls"));
  const result = run(prepare, [config.targetOrg, folder, classes], config.worktree, undefined, {
    ANALYZER_CONFIG: join(REPO_ROOT, "code-analyzer.yml"),
    PMD_RULE_SELECTOR: reuse || off("PMD") ? "pmd" : pmdRuleSelector(config, folder),
    ANALYZER_TARGETS: appClasses.join(","),
    SKIP_DEPLOY: streamline || reuse ? "1" : "",
    SKIP_PMD: reuse ? "1" : off("PMD"),
    SKIP_SFGE: reuse ? "1" : off("Graph Engine"),
    SKIP_TESTS: streamline ? "1" : off(...TEST_DIMENSIONS),
    SKIP_LOGS: off("Limit headroom", "Resource efficiency")
  });
  writeFileSync(join(folder, "prepare.log"), result.stdout + result.stderr);
  if (result.status !== 0) throw new Error(`score-prepare failed, see ${join(folder, "prepare.log")}`);
  for (const file of reuse ? ["deploy.json", "pmd.json", "sfge.json"] : []) {
    if (existsSync(join(reuseAnalysisFrom!, file))) copyFileSync(join(reuseAnalysisFrom!, file), join(folder, file));
  }
  if (streamline) {
    assertScratchOrg(config.targetOrg);
    try {
      for (const suite of config.streamline!) compose(config.worktree, folder, suite);
    } catch (error) {
      if (!(error instanceof ExtractError)) throw error;
      writeFileSync(join(folder, "extract-error.txt"), error.message);
      return { gated: true, gate: "extract", gateDetail: error.message, overall: 0 };
    }
    await runVariants(MCP_CONFIG, config.targetOrg, folder, config.streamline!.flatMap((s) => Object.keys(s.variants)));
  }
  return scoreRun(scoreOptions(config, folder));
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

/** Trailing discards since the last keep in which no focus dimension rose by more than its margin. Unscored entries are skipped. */
export function plateauDiscards(history: HistoryEntry[], margins: Record<string, number>): number {
  const current = kept(history).at(-1)!.scores ?? {};
  let count = 0;
  for (const entry of history.filter((e) => !e.dryRun).reverse()) {
    if (entry.outcome === "keep" || entry.outcome === "baseline") break;
    if (entry.outcome !== "discard" || !entry.scores) continue;
    const rose = (entry.focus ?? []).some((f) => entry.scores![f]! - current[f]! > (margins[f] ?? 0));
    if (rose) break;
    count++;
  }
  return count;
}

/** True when no dimension can rise by more than its margin, so no candidate can be kept. */
export function atSummit(scores: Record<string, number>, margins: Record<string, number>): boolean {
  return Object.entries(scores).every(([d, score]) => 100 - score <= (margins[d] ?? 0));
}

/** Each static analysis suppression in Apex source, once per occurrence: PMD rules in @SuppressWarnings, NOPMD comments and analyzer markers. */
export function suppressions(source: string): string[] {
  const found: string[] = [];
  for (const [, values] of source.matchAll(/@SuppressWarnings\s*\(\s*'([^']*)'\s*\)/gi)) {
    found.push(...values.split(",").map((v) => v.trim().toLowerCase()).filter((v) => v.startsWith("pmd")));
  }
  for (const [marker] of source.matchAll(/NOPMD|code-analyzer-suppress(\([^)]*\))?|sfge-disable[\w-]*/gi)) found.push(marker.toLowerCase());
  return found;
}

/** Suppressions in `after` beyond those in `before`, so reformatting or moving an existing one adds nothing. */
export function addedSuppressions(before: string, after: string): string[] {
  const counts = new Map<string, number>();
  for (const s of suppressions(before)) counts.set(s, (counts.get(s) ?? 0) + 1);
  return suppressions(after).filter((s) => {
    const left = counts.get(s) ?? 0;
    counts.set(s, left - 1);
    return left <= 0;
  });
}

export const BASELINE_RUNS = 3;

/** How many times the margin of a nondeterministic dimension is the range of its repeated baseline scores. */
const NOISE_FACTOR = 1.5;

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

const mean = (values: number[]) => values.reduce((sum, v) => sum + v, 0) / values.length;

const round = (n: number) => Math.round(n * 10) / 10;

/** For each nondeterministic dimension, the larger of its configured margin and NOISE_FACTOR times the range of the repeated runs. */
export function measureNoise(runs: Record<string, number>[], margins: Record<string, number>): NonNullable<AscentConfig["noise"]> {
  const names = Object.keys(runs[0]).filter((d) => !DETERMINISTIC[d]);
  return Object.fromEntries(
    names.map((d) => {
      const scores = runs.map((r) => r[d]);
      const configured = margins[d] ?? 0;
      return [d, { scores, configured, margin: round(Math.max(configured, NOISE_FACTOR * (Math.max(...scores) - Math.min(...scores)))) }];
    })
  );
}

/**
 * Scores from several runs of the same code: nondeterministic dimensions combined (median or mean), the rest from the first run.
 * The overall score is recomputed from the dimension weights of the first run.
 */
export function combineRuns(results: ScoreResult[], combine: "median" | "mean"): { scores: Record<string, number>; overall: number } {
  const first = results[0].dimensions ?? [];
  const runs = results.map(scoresByName);
  const scores = Object.fromEntries(
    first.map((d) => [d.name, DETERMINISTIC[d.name] ? d.score : round((combine === "median" ? median : mean)(runs.map((r) => r[d.name])))])
  );
  const totalWeight = first.reduce((sum, d) => sum + d.weight, 0);
  return { scores, overall: round(first.reduce((sum, d) => sum + d.weight * scores[d.name], 0) / totalWeight) };
}

/**
 * True when a discard rests only on nondeterministic dimensions that each miss their keep threshold by no more than
 * their margin, so one more measurement could change the outcome.
 */
export function closeDiscard(
  current: Record<string, number>,
  best: Record<string, number>,
  scores: Record<string, number>,
  focus: string[],
  margins: Record<string, number>
): boolean {
  let failed = false;
  for (const [name, score] of Object.entries(scores)) {
    if (score < (best[name] ?? 0) / 2) return false;
    const delta = score - current[name];
    const margin = margins[name] ?? 0;
    const shortfall = focus.includes(name) ? margin - delta : -margin - delta;
    if (focus.includes(name) ? delta > margin : delta >= -margin) continue;
    if (DETERMINISTIC[name] || shortfall > margin) return false;
    failed = true;
  }
  return failed;
}

/** The mirror of closeDiscard: true when a nondeterministic focus dimension clears its keep threshold by no more than its margin. */
export function closeKeep(current: Record<string, number>, scores: Record<string, number>, focus: string[], margins: Record<string, number>): boolean {
  return focus.some((name) => {
    const margin = margins[name] ?? 0;
    const surplus = scores[name] - current[name] - margin;
    return !DETERMINISTIC[name] && surplus > 0 && surplus <= margin;
  });
}

/** Notes on a keep that a person should review. Tests cannot change, so a coverage rise can only come from removing or restructuring application code. */
export function reviewFlags(current: Record<string, number>, scores: Record<string, number>, margins: Record<string, number>): string[] {
  const rise = scores["Code coverage"] - current["Code coverage"];
  return rise > (margins["Code coverage"] ?? 0)
    ? [`Code coverage rose by ${rise.toFixed(1)} with no test change: check that the removed or restructured code could never run`]
    : [];
}

/**
 * The keep rule from doc/design.md: every focus dimension rises by more than its margin, no other dimension
 * falls by more than its margin, and no dimension drops below half its best score. A candidate whose only
 * failure is a missed focus is still kept when the overall score rises by more than any one dimension's
 * margin can move it.
 */
export function decide(
  current: Record<string, number>,
  best: Record<string, number>,
  candidate: ScoreResult,
  focus: string[],
  margins: Record<string, number>,
  currentOverall?: number
): { outcome: "keep" | "discard" | "gated"; reasons: string[] } {
  if (candidate.gated) {
    const detail = candidate.gateDetail ? `: ${candidate.gateDetail}` : "";
    return { outcome: "gated", reasons: [`gated by ${candidate.gate}${detail}`] };
  }
  const scores = scoresByName(candidate);
  const focusMisses: string[] = [];
  const reasons: string[] = [];
  for (const name of DIMENSION_NAMES.filter((d) => d in scores)) {
    const delta = scores[name] - current[name];
    const margin = margins[name] ?? 0;
    if (focus.includes(name) && !(delta > margin)) {
      focusMisses.push(`${name} is a focus but rose ${delta.toFixed(1)}, not more than its margin ${margin}`);
    }
    if (!focus.includes(name) && delta < -margin) {
      reasons.push(`${name} fell ${(-delta).toFixed(1)}, more than its margin ${margin}`);
    }
    if (scores[name] < (best[name] ?? 0) / 2) {
      reasons.push(`${name} at ${scores[name]} is below half its best ${best[name]}`);
    }
  }
  if (reasons.length === 0 && focusMisses.length === 0) {
    return { outcome: "keep", reasons: ["every focus dimension rose by more than its margin and no other dimension fell by more than its margin"] };
  }
  const dimensions = candidate.dimensions ?? [];
  const totalWeight = dimensions.reduce((sum, d) => sum + d.weight, 0);
  const overallMargin = Math.max(0, ...dimensions.map((d) => (d.weight * (margins[d.name] ?? 0)) / totalWeight));
  const overallRise = currentOverall === undefined ? 0 : candidate.overall - currentOverall;
  if (reasons.length === 0 && overallRise > overallMargin) {
    const overall = `overall rose ${overallRise.toFixed(1)}, more than its margin ${overallMargin.toFixed(1)}`;
    return { outcome: "keep", reasons: [`${overall} and no dimension fell by more than its margin`, ...focusMisses] };
  }
  return { outcome: "discard", reasons: [...focusMisses, ...reasons] };
}
