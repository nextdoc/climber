import { existsSync, globSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

type Violation = {
  engine: string;
  rule: string;
  message: string;
  severity: number;
  primaryLocationIndex: number;
  locations: { file: string; startLine: number }[];
};

type TestSummary = {
  testsRan: number;
  passing: number;
  failing: number;
  testExecutionTime: string;
};

type ClassCoverage = { name: string; totalLines: number; totalCovered: number };

/** Weight per dimension. A missing dimension weighs 1, and 0 disables it and skips its tool. */
export type Weights = Partial<Record<string, number>>;

/** How a run collects its inputs: deploy with the sf CLI, or Streamline scripts. Fixed for an ascent. */
export type Mode = "deploy" | "streamline";

/**
 * headroomTest: the test whose limit use scores limit headroom.
 * runCounts: how many test runs each Streamline measured scenario stands for in resource efficiency. A missing scenario counts once.
 */
export type ScoreOptions = {
  app: string[];
  test: string[];
  run: string;
  root: string;
  headroomTest: string;
  weights?: Weights;
  mode?: Mode;
  runCounts?: Record<string, number>;
};

export type DimensionScore = { name: string; weight: number; score: number; [detail: string]: unknown };

export type ScoreResult = { dimensions?: DimensionScore[]; gated: boolean; gate?: string; overall: number };

/** Whether each dimension scores unchanged code the same on every run. Only nondeterministic margins are measured. */
export const DETERMINISTIC: Record<string, boolean> = {
  PMD: true,
  "Graph Engine": true,
  "Tests passing": true,
  "Code coverage": true,
  "Test run time": false,
  "Limit headroom": false,
  "Resource efficiency": false
};

export const DIMENSION_NAMES = Object.keys(DETERMINISTIC);

export const weightOf = (weights: Weights | undefined, name: string) => weights?.[name] ?? 1;

export const enabledDimensions = (weights: Weights | undefined) => DIMENSION_NAMES.filter((d) => weightOf(weights, d) > 0);

const SEVERITY_WEIGHTS: Record<number, number> = { 1: 16, 2: 8, 3: 4, 4: 2, 5: 1 };

// Heap is left out: TESTING_LIMITS always reports it as 0.
const GOVERNOR_LIMITS = [
  "Number of SOQL queries",
  "Number of query rows",
  "Number of DML statements",
  "Number of DML rows",
  "Maximum CPU time"
];

const round = (n: number) => Math.round(n * 10) / 10;

const readJson = (file: string) => JSON.parse(readFileSync(file, "utf8"));

const halfScore = (halfScorePenalty: number, penalty: number) => (100 * halfScorePenalty) / (halfScorePenalty + penalty);

function resolveFiles(patterns: string[], root: string): Set<string> {
  return new Set(patterns.flatMap((p) => globSync(p, { cwd: root })).map((f) => resolve(root, f)));
}

function appFiles(opts: ScoreOptions): Set<string> {
  const testFiles = resolveFiles(opts.test, opts.root);
  return new Set([...resolveFiles(opts.app, opts.root)].filter((f) => !testFiles.has(f)));
}

function appViolations(file: string, files: Set<string>, root: string): Violation[] {
  const violations: Violation[] = readJson(file).violations;
  return violations.filter((v) => files.has(resolve(root, v.locations[v.primaryLocationIndex].file)));
}

/** One line per static analysis violation in application files, for the planner. */
export function findings(opts: ScoreOptions): string[] {
  const files = appFiles(opts);
  return ["pmd.json", "sfge.json"]
    .filter((f) => existsSync(join(opts.run, f)))
    .flatMap((f) =>
    appViolations(join(opts.run, f), files, opts.root).map((v) => {
      const location = v.locations[v.primaryLocationIndex];
      return `${v.engine} ${v.rule} (severity ${v.severity}) ${location.file.split("/").pop()}:${location.startLine}: ${v.message}`;
    })
  );
}

function scoreViolations(name: string, file: string, files: Set<string>, root: string): DimensionScore {
  const counted = appViolations(file, files, root);
  const penalty = counted.reduce((sum, v) => sum + SEVERITY_WEIGHTS[v.severity], 0);
  return { name, weight: 1, violations: counted.length, penalty, score: halfScore(50, penalty) };
}

function scoreTestsPassing(summary: TestSummary): DimensionScore {
  const score = summary.testsRan === 0 ? 0 : (100 * summary.passing) / summary.testsRan;
  return {
    name: "Tests passing",
    weight: 1,
    testsRan: summary.testsRan,
    failing: summary.failing,
    score
  };
}

/** Line coverage of application classes. A class no test executes is absent from the results, so it is listed, not counted. */
function scoreCoverage(coverage: ClassCoverage[], files: Set<string>): DimensionScore {
  const classes = new Set([...files].map((f) => basename(f, ".cls")));
  const covered = coverage.filter((c) => classes.has(c.name));
  const lines = covered.reduce((sum, c) => sum + c.totalLines, 0);
  const coveredLines = covered.reduce((sum, c) => sum + c.totalCovered, 0);
  const notRun = [...classes].filter((name) => !covered.some((c) => c.name === name));
  return {
    name: "Code coverage",
    weight: 1,
    lines,
    coveredLines,
    notRun,
    score: lines === 0 ? 0 : (100 * coveredLines) / lines
  };
}

function scoreTestRunTime(summary: TestSummary): DimensionScore {
  const seconds = parseInt(summary.testExecutionTime, 10) / 1000;
  return { name: "Test run time", weight: 1, seconds, score: halfScore(40, seconds) };
}

type LimitUsage = Record<string, { used: number; limit: number }>;

/**
 * Reads each test's TESTING_LIMITS block, which covers only code between Test.startTest and Test.stopTest.
 * Tests without the block, such as ones that never call Test.startTest, are absent.
 */
function testLimits(log: string): Map<string, LimitUsage> {
  const byTest = new Map<string, LimitUsage>();
  const sections = log.split(/\|CODE_UNIT_STARTED\|\[EXTERNAL\]\|\w+\|(\S+)\(\)\n/);
  for (let i = 1; i < sections.length; i += 2) {
    const testingLimits = sections[i + 1].split("|TESTING_LIMITS")[1];
    if (testingLimits === undefined) continue;
    const defaultNamespace = testingLimits.split("|LIMIT_USAGE_FOR_NS|")[1]?.split("\n\n")[0] ?? "";
    const usage: LimitUsage = {};
    for (const [, name, used, limit] of defaultNamespace.matchAll(/^\s+(.+): (\d+) out of (\d+)/gm)) {
      if (GOVERNOR_LIMITS.includes(name)) usage[name] = { used: Number(used), limit: Number(limit) };
    }
    byTest.set(sections[i], usage);
  }
  return byTest;
}

const percentOf = (u: { used: number; limit: number }) => round((100 * u.used) / u.limit);

function scoreHeadroom(limits: Map<string, LimitUsage>, test: string): DimensionScore {
  const usage = limits.get(test);
  if (usage === undefined) {
    return { name: "Limit headroom", weight: 1, test, peakPercent: null, score: 0 };
  }
  const percentOfLimit = Object.fromEntries(Object.entries(usage).map(([name, u]) => [name, percentOf(u)]));
  const peakPercent = Math.max(...Object.values(percentOfLimit));
  return {
    name: "Limit headroom",
    weight: 1,
    test,
    percentOfLimit,
    peakPercent,
    score: Math.max(0, 100 - peakPercent)
  };
}

function scoreEfficiency(limits: Map<string, LimitUsage>, headroomTest: string, runCounts: Record<string, number> = {}): DimensionScore {
  const totals: LimitUsage = {};
  for (const [test, usage] of limits) {
    if (test === headroomTest) continue;
    for (const [name, u] of Object.entries(usage)) {
      totals[name] ??= { used: 0, limit: u.limit };
      totals[name].used += u.used * (runCounts[test] ?? 1);
    }
  }
  const percentOfLimit = Object.fromEntries(Object.entries(totals).map(([name, u]) => [name, percentOf(u)]));
  const penalty = round(Object.values(percentOfLimit).reduce((sum, p) => sum + p, 0));
  return { name: "Resource efficiency", weight: 1, percentOfLimit, penalty, score: halfScore(170, penalty) };
}

/** Streamline scripts log results as TEST|Class.method|PASS, FAIL or SKIP, and limit use as LIMITS|Class.method|{"name": {used, limit}}. */
const streamlineLines = (log: string, kind: string) =>
  [...log.replaceAll("&#124;", "|").matchAll(new RegExp(`\\|DEBUG\\|${kind}\\|([^|]+)\\|(.*)$`, "gm"))].map((m) => [m[1], m[2]] as const);

type VariantOutcome = { compiled: boolean; success: boolean };

/** An uncaught exception stops a variant before it logs its remaining tests, so each one counts as one failing test. */
function streamlineTests(log: string, variants: VariantOutcome[]): TestSummary {
  const outcomes = streamlineLines(log, "TEST").map(([, outcome]) => outcome).filter((o) => !o.startsWith("SKIP"));
  const passing = outcomes.filter((o) => o === "PASS").length;
  const testsRan = outcomes.length + variants.filter((v) => !v.success).length;
  return { testsRan, passing, failing: testsRan - passing, testExecutionTime: "" };
}

const streamlineLimits = (log: string) =>
  new Map(streamlineLines(log, "LIMITS").map(([test, json]) => [test, JSON.parse(json) as LimitUsage]));

const readLogs = (run: string) => {
  const logsDir = join(run, "logs");
  return readdirSync(logsDir).map((f) => readFileSync(join(logsDir, f), "utf8")).join("\n");
};

const unavailable = (name: string) => () => {
  throw new Error(`${name} is not available in streamline mode. Set its weight to 0.`);
};

export function scoreRun(opts: ScoreOptions): ScoreResult {
  const streamline = opts.mode === "streamline";
  const variants: VariantOutcome[] = streamline ? readJson(join(opts.run, "streamline.json")) : [];
  const compiled = streamline ? variants.every((v) => v.compiled) : readJson(join(opts.run, "deploy.json")).result?.success === true;
  if (!compiled) {
    return { gated: true, gate: "compile", overall: 0 };
  }
  const enabled = enabledDimensions(opts.weights);
  if (enabled.length === 0) throw new Error("Every dimension has weight 0");
  const files = appFiles(opts);
  const tests = () => readJson(join(opts.run, "tests.json")).result;
  const limits = () => (streamline ? streamlineLimits : testLimits)(readLogs(opts.run));
  const scorers: Record<string, () => DimensionScore> = {
    PMD: () => scoreViolations("PMD", join(opts.run, "pmd.json"), files, opts.root),
    "Graph Engine": () => scoreViolations("Graph Engine", join(opts.run, "sfge.json"), files, opts.root),
    "Tests passing": () => scoreTestsPassing(streamline ? streamlineTests(readLogs(opts.run), variants) : tests().summary),
    "Code coverage": streamline ? unavailable("Code coverage") : () => scoreCoverage(tests().coverage?.coverage ?? [], files),
    "Test run time": streamline ? unavailable("Test run time") : () => scoreTestRunTime(tests().summary),
    "Limit headroom": () => scoreHeadroom(limits(), opts.headroomTest),
    "Resource efficiency": () => scoreEfficiency(limits(), opts.headroomTest, streamline ? opts.runCounts : undefined)
  };
  const dimensions = enabled.map((name) => ({ ...scorers[name](), weight: weightOf(opts.weights, name) }));
  const totalWeight = dimensions.reduce((sum, d) => sum + d.weight, 0);
  const overall = dimensions.reduce((sum, d) => sum + d.weight * d.score, 0) / totalWeight;
  return {
    dimensions: dimensions.map((d) => ({ ...d, score: round(d.score) })),
    gated: false,
    overall: round(overall)
  };
}
