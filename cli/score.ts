import { globSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Command } from "commander";

type Violation = {
  severity: number;
  primaryLocationIndex: number;
  locations: { file: string }[];
};

type TestSummary = {
  testsRan: number;
  passing: number;
  failing: number;
  testExecutionTime: string;
  testRunCoverage: string;
};

type Options = { app: string[]; test: string[]; run: string };

type DimensionScore = { name: string; weight: number; score: number; [detail: string]: unknown };

const SEVERITY_WEIGHTS: Record<number, number> = { 1: 16, 2: 8, 3: 4, 4: 2, 5: 1 };

// Heap is left out: TESTING_LIMITS always reports it as 0.
const GOVERNOR_LIMITS = [
  "Number of SOQL queries",
  "Number of query rows",
  "Number of DML statements",
  "Number of DML rows",
  "Maximum CPU time"
];

const HEADROOM_TEST = "AccountHealthRollupTest.headroomAt200Accounts";

const round = (n: number) => Math.round(n * 10) / 10;

const readJson = (file: string) => JSON.parse(readFileSync(file, "utf8"));

const halfScore = (halfScorePenalty: number, penalty: number) => (100 * halfScorePenalty) / (halfScorePenalty + penalty);

function resolveFiles(patterns: string[]): Set<string> {
  return new Set(patterns.flatMap((p) => globSync(p)).map((f) => resolve(f)));
}

function scoreViolations(name: string, file: string, appFiles: Set<string>): DimensionScore {
  const violations: Violation[] = readJson(file).violations;
  const counted = violations.filter((v) => appFiles.has(resolve(v.locations[v.primaryLocationIndex].file)));
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
    coverage: summary.testRunCoverage,
    score
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

function scoreHeadroom(limits: Map<string, LimitUsage>): DimensionScore {
  const usage = limits.get(HEADROOM_TEST);
  if (usage === undefined) {
    return { name: "Limit headroom", weight: 1, test: HEADROOM_TEST, peakPercent: null, score: 0 };
  }
  const percentOfLimit = Object.fromEntries(Object.entries(usage).map(([name, u]) => [name, percentOf(u)]));
  const peakPercent = Math.max(...Object.values(percentOfLimit));
  return {
    name: "Limit headroom",
    weight: 1,
    test: HEADROOM_TEST,
    percentOfLimit,
    peakPercent,
    score: Math.max(0, 100 - peakPercent)
  };
}

function scoreEfficiency(limits: Map<string, LimitUsage>): DimensionScore {
  const totals: LimitUsage = {};
  for (const [test, usage] of limits) {
    if (test === HEADROOM_TEST) continue;
    for (const [name, u] of Object.entries(usage)) {
      totals[name] ??= { used: 0, limit: u.limit };
      totals[name].used += u.used;
    }
  }
  const percentOfLimit = Object.fromEntries(Object.entries(totals).map(([name, u]) => [name, percentOf(u)]));
  const penalty = round(Object.values(percentOfLimit).reduce((sum, p) => sum + p, 0));
  return { name: "Resource efficiency", weight: 1, percentOfLimit, penalty, score: halfScore(170, penalty) };
}

function scoreRun(opts: Options) {
  const deploy = readJson(join(opts.run, "deploy.json"));
  if (deploy.result?.success !== true) {
    return { gated: true, gate: "compile", overall: 0 };
  }
  const testFiles = resolveFiles(opts.test);
  const appFiles = new Set([...resolveFiles(opts.app)].filter((f) => !testFiles.has(f)));
  const summary: TestSummary = readJson(join(opts.run, "tests.json")).result.summary;
  const logsDir = join(opts.run, "logs");
  const limits = testLimits(readdirSync(logsDir).map((f) => readFileSync(join(logsDir, f), "utf8")).join("\n"));
  const dimensions = [
    scoreViolations("PMD", join(opts.run, "pmd.json"), appFiles),
    scoreViolations("Graph Engine", join(opts.run, "sfge.json"), appFiles),
    scoreTestsPassing(summary),
    scoreTestRunTime(summary),
    scoreHeadroom(limits),
    scoreEfficiency(limits)
  ];
  const totalWeight = dimensions.reduce((sum, d) => sum + d.weight, 0);
  const overall = dimensions.reduce((sum, d) => sum + d.weight * d.score, 0) / totalWeight;
  return {
    dimensions: dimensions.map((d) => ({ ...d, score: round(d.score) })),
    gated: false,
    overall: round(overall)
  };
}

const program = new Command()
  .name("score")
  .description("Score a run folder written by cli/score-prepare.sh, 0 to 100 per dimension, as defined in doc/scoring.md")
  .requiredOption("-a, --app <globs...>", "application Apex file globs")
  .requiredOption("-t, --test <globs...>", "test Apex file globs (removed from the application set)")
  .option("-r, --run <dir>", "run folder", "target/tmp/score")
  .action((opts: Options) => {
    console.log(JSON.stringify(scoreRun(opts), null, 2));
  });

program.parse();
