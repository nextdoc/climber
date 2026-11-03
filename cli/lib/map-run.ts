import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { REPO_ROOT, run } from "./ascent.ts";

const DEBUG_LEVEL = "ClimbScore";

const LOG_FETCHES = 8;

const MANIFEST = "collected.json";

export type Skip = { pmd: boolean; sfge: boolean; tests: boolean; logs: boolean };

/** tests: the test classes to run. targets: the app class files to analyse, relative to root. */
export type Collection = { tests: string[]; targets: string[]; skip: Skip };

type TestResult = { ApexClass: { Name: string }; Outcome?: string; Message?: string | null; RunTime?: number; TestSetupTime?: number };

type CoverageRecord = { ApexTestClass: { Name: string }; ApexClassOrTrigger: { Name: string }; Coverage: { coveredLines: number[]; uncoveredLines: number[] } };

type RunResult = {
  summary?: unknown;
  tests?: TestResult[];
  setup?: TestResult[];
  coverage?: { coverage?: { name: string; totalLines: number }[]; records?: CoverageRecord[] };
};

const readJson = (file: string) => JSON.parse(readFileSync(file, "utf8"));

const writeJson = (file: string, value: unknown) => writeFileSync(file, JSON.stringify(value, null, 2) + "\n");

function sf(org: string, cwd: string, args: string[]) {
  const result = run("sf", [...args, "-o", org, "--json"], cwd);
  const out = (() => {
    try {
      return JSON.parse(result.stdout);
    } catch {
      return undefined;
    }
  })();
  if (out === undefined || (out.status ?? 0) !== 0) throw new Error(`sf ${args.slice(0, 3).join(" ")} failed: ${out?.message ?? result.stderr}`);
  return out.result;
}

const ids = (org: string, cwd: string, query: string, tooling = true): string[] =>
  (sf(org, cwd, ["data", "query", ...(tooling ? ["--use-tooling-api"] : []), "-q", query])?.records ?? []).map((r: { Id: string }) => r.Id);

/** Traces the org user for an hour from start, logging only the profiling that holds the TESTING_LIMITS blocks. */
function enableTraceFlag(org: string, cwd: string, start: string) {
  const [existingLevel] = ids(org, cwd, `SELECT Id FROM DebugLevel WHERE DeveloperName = '${DEBUG_LEVEL}'`);
  const level =
    existingLevel ??
    sf(org, cwd, [
      "data", "create", "record", "--use-tooling-api", "-s", "DebugLevel", "-v",
      `DeveloperName=${DEBUG_LEVEL} MasterLabel=${DEBUG_LEVEL} ApexCode=ERROR ApexProfiling=INFO Database=NONE System=NONE Workflow=NONE Validation=NONE Callout=NONE Visualforce=NONE`
    ]).id;
  const username = sf(org, cwd, ["org", "display"]).username;
  const [user] = ids(org, cwd, `SELECT Id FROM User WHERE Username = '${username}'`, false);
  const end = new Date(Date.parse(start) + 60 * 60 * 1000).toISOString();
  const [flag] = ids(org, cwd, `SELECT Id FROM TraceFlag WHERE TracedEntityId = '${user}' AND LogType = 'USER_DEBUG'`);
  const values = `DebugLevelId=${level} StartDate=${start} ExpirationDate=${end}`;
  if (flag) sf(org, cwd, ["data", "update", "record", "--use-tooling-api", "-s", "TraceFlag", "-i", flag, "-v", values]);
  else sf(org, cwd, ["data", "create", "record", "--use-tooling-api", "-s", "TraceFlag", "-v", `TracedEntityId=${user} LogType=USER_DEBUG ${values}`]);
}

function analyse(engine: "pmd" | "sfge", args: string[], root: string, out: string) {
  const result = run("sf", ["code-analyzer", "run", "--config-file", join(REPO_ROOT, "code-analyzer.yml"), "--rule-selector", engine, ...args, "--output-file", join(out, `${engine}.json`)], root);
  writeFileSync(join(out, `${engine}.log`), result.stdout + result.stderr);
  if (result.status !== 0) throw new Error(`${engine} failed, see ${join(out, `${engine}.log`)}`);
}

/** The org writes one log per test class, a few seconds after the run, so this waits for one per class that ran. */
async function fetchLogs(org: string, root: string, out: string, start: string, expected: number, log: (m: string) => void) {
  let found: string[] = [];
  for (let attempt = 0; attempt < 12 && found.length < expected; attempt++) {
    if (attempt > 0) await sleep(5000);
    found = ids(org, root, `SELECT Id FROM ApexLog WHERE Operation = 'ApexTestHandler' AND StartTime >= ${start}`);
  }
  if (found.length === 0) throw new Error("No test logs found");
  if (found.length < expected) log(`Warning: found ${found.length} of ${expected} test logs`);
  log(`Fetching ${found.length} logs`);
  const queue = [...found];
  const fetch = promisify(execFile);
  await Promise.all(
    Array.from({ length: LOG_FETCHES }, async () => {
      for (let id = queue.shift(); id; id = queue.shift()) {
        await fetch("sf", ["apex", "get", "log", "-o", org, "-i", id, "-d", join(out, "logs")], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
      }
    })
  );
}

/** Whether out holds a collection that covers every test, target and input wanted. */
export function collected(out: string, wanted: Collection) {
  if (!existsSync(join(out, MANIFEST))) return false;
  const have: Collection = readJson(join(out, MANIFEST));
  const covers = (a: string[], b: string[]) => b.every((x) => a.includes(x));
  return covers(have.tests, wanted.tests) && covers(have.targets, wanted.targets) && (Object.keys(wanted.skip) as (keyof Skip)[]).every((k) => wanted.skip[k] || !have.skip[k]);
}

/** Runs the analyzers and the tests once against the org's code, into out, as doc/mapping.md "Scoring in one pass" describes. */
export async function collectRun(org: string, root: string, out: string, c: Collection, log = console.error) {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, "logs"), { recursive: true });
  mkdirSync(join(root, "target/tmp/code-analyzer/logs"), { recursive: true });
  const targets = c.targets.flatMap((t) => ["--target", t]);
  if (!c.skip.pmd) {
    log(`Running PMD over ${c.targets.length} classes`);
    analyse("pmd", targets, root, out);
  }
  if (!c.skip.sfge) {
    log(`Running Graph Engine over ${c.targets.length} classes`);
    analyse("sfge", ["--workspace", "force-app", ...targets], root, out);
  }
  if (!c.skip.tests) {
    const start = new Date().toISOString();
    if (!c.skip.logs) enableTraceFlag(org, root, start);
    log(`Running ${c.tests.length} test classes`);
    const tests = run("sf", ["apex", "run", "test", "-o", org, "-n", c.tests.join(","), "--code-coverage", "--detailed-coverage", "--result-format", "json", "-w", "20"], root);
    writeFileSync(join(out, "tests.json"), tests.stdout);
    const result: RunResult | undefined = (() => {
      try {
        return JSON.parse(tests.stdout).result;
      } catch {
        return undefined;
      }
    })();
    if (result?.summary === undefined) throw new Error(`The tests did not run: ${tests.stderr || tests.stdout}`);
    const classesRan = new Set([...(result.tests ?? []), ...(result.setup ?? [])].map((t) => t.ApexClass.Name)).size;
    if (!c.skip.logs) await fetchLogs(org, root, out, start, Math.max(1, classesRan), log);
  }
  writeJson(join(out, MANIFEST), c);
}

/** app: the group's app class files, relative to root. */
export type SliceGroup = { id: string; tests: string[]; app: string[] };

/** A group's share of the run's results: its test classes' methods and setup, and the lines they cover. */
export function groupTests(result: RunResult, tests: string[]) {
  const mine = (r: TestResult) => tests.includes(r.ApexClass.Name);
  const methods = (result.tests ?? []).filter(mine);
  const setups = (result.setup ?? []).filter(mine);
  const all = [...methods, ...setups];
  const passing = all.filter((r) => (r.Outcome ?? (r.Message ? "Fail" : "Pass")) === "Pass").length;
  const ms = methods.reduce((n, r) => n + (r.RunTime ?? 0), 0) + setups.reduce((n, r) => n + (r.TestSetupTime ?? 0), 0);
  const totals = new Map((result.coverage?.coverage ?? []).map((c) => [c.name, c.totalLines]));
  const lines = new Map<string, { covered: Set<number>; all: Set<number> }>();
  for (const r of (result.coverage?.records ?? []).filter((r) => tests.includes(r.ApexTestClass.Name))) {
    const entry = lines.get(r.ApexClassOrTrigger.Name) ?? { covered: new Set(), all: new Set() };
    lines.set(r.ApexClassOrTrigger.Name, entry);
    r.Coverage.coveredLines.forEach((l) => (entry.covered.add(l), entry.all.add(l)));
    r.Coverage.uncoveredLines.forEach((l) => entry.all.add(l));
  }
  return {
    result: {
      summary: { testsRan: all.length, passing, failing: all.length - passing, testExecutionTime: `${ms} ms` },
      coverage: { coverage: [...lines].map(([name, l]) => ({ name, totalLines: totals.get(name) ?? l.all.size, totalCovered: l.covered.size })) }
    }
  };
}

/** The first test the log runs, as its class name without a namespace. */
const TEST_UNIT = /\|CODE_UNIT_STARTED\|\[EXTERNAL\]\|\w+\|(?:\w+\.)?(\w+)\.\w+\(\)\r?$/m;

/** Writes each group's share of the run into runsDir/<id>, in the shape scoreRun reads. A group without tests gets no tests.json. */
export function sliceRun(runDir: string, root: string, groups: SliceGroup[], runsDir: string) {
  const result: RunResult | undefined = existsSync(join(runDir, "tests.json")) ? readJson(join(runDir, "tests.json")).result : undefined;
  const logs = existsSync(join(runDir, "logs")) ? readdirSync(join(runDir, "logs")) : [];
  const logClass = new Map(logs.map((f) => [f, readFileSync(join(runDir, "logs", f), "utf8").match(TEST_UNIT)?.[1]]));
  const analyses = ["pmd.json", "sfge.json"].filter((f) => existsSync(join(runDir, f))).map((f) => [f, readJson(join(runDir, f))] as const);
  for (const g of groups) {
    const folder = join(runsDir, g.id);
    rmSync(folder, { recursive: true, force: true });
    mkdirSync(folder, { recursive: true });
    const files = new Set(g.app.map((f) => resolve(root, f)));
    for (const [name, analysis] of analyses) {
      const violations = analysis.violations.filter((v: { primaryLocationIndex: number; locations: { file: string }[] }) => files.has(resolve(root, v.locations[v.primaryLocationIndex].file)));
      writeJson(join(folder, name), { ...analysis, violations });
    }
    if (g.tests.length === 0 || result === undefined) continue;
    writeJson(join(folder, "tests.json"), groupTests(result, g.tests));
    mkdirSync(join(folder, "logs"));
    for (const f of logs.filter((f) => g.tests.includes(logClass.get(f) ?? ""))) cpSync(join(runDir, "logs", f), join(folder, "logs", f));
  }
}
