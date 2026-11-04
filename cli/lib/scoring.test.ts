import { beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./ascent.ts";
import { scoreRun } from "./scoring.ts";

const round = (n: number) => Math.round(n * 10) / 10;

const RUN = join(REPO_ROOT, "target/tmp/scoring-test");

const log = (...lines: string[]) => lines.map((l, i) => `${i}\t12:00:00.0|USER_DEBUG|[1]|DEBUG|${l.replaceAll("|", "&#124;")}`).join("\n");

const limits = (cpu: number) => JSON.stringify({ "Maximum CPU time": { used: cpu, limit: 10000 } });

const score = (headroomTest = ["T.headroom"], halfScores?: Record<string, number>) =>
  scoreRun({
    app: [],
    test: [],
    run: RUN,
    root: RUN,
    mode: "streamline",
    headroomTest,
    weights: { PMD: 0, "Graph Engine": 0, "Code coverage": 0, "Test run time": 0 },
    runCounts: { "T.main": 3 },
    halfScores
  });

const variants = (...v: { variant?: string; compiled: boolean; success: boolean; compileProblem?: string }[]) => writeFileSync(join(RUN, "streamline.json"), JSON.stringify(v));

beforeEach(() => {
  rmSync(RUN, { recursive: true, force: true });
  mkdirSync(join(RUN, "logs"), { recursive: true });
  writeFileSync(join(RUN, "logs/correctness.log"), log("TEST|T.a|PASS", "TEST|T.b|SKIP static", `LIMITS|T.main|${limits(1000)}`));
  writeFileSync(join(RUN, "logs/headroom.log"), log("TEST|T.c|PASS", `LIMITS|T.headroom|${limits(4000)}`));
});

test("scores streamline logs, multiplying limit use by run counts and leaving out the headroom test", () => {
  variants({ compiled: true, success: true }, { compiled: true, success: true });
  const dimensions = Object.fromEntries(score().dimensions!.map((d) => [d.name, d]));
  expect(dimensions["Tests passing"]).toMatchObject({ testsRan: 2, failing: 0, score: 100 });
  expect(dimensions["Limit headroom"]).toMatchObject({ tests: { "T.headroom": { peakPercent: 40 } }, score: 60 });
  expect(dimensions["Resource efficiency"]).toMatchObject({ classes: { T: { percentOfLimit: { "Maximum CPU time": 30 } } } });
});

test("scores each climbed class on its own and averages them", () => {
  variants({ compiled: true, success: true }, { compiled: true, success: true }, { compiled: true, success: true });
  writeFileSync(join(RUN, "logs/other.log"), log("TEST|U.a|PASS", `LIMITS|U.main|${limits(1700)}`, `LIMITS|U.headroom|${limits(8000)}`));
  const dimensions = Object.fromEntries(score(["T.headroom", "U.headroom"]).dimensions!.map((d) => [d.name, d]));
  expect(dimensions["Limit headroom"].score).toBe(40);
  expect(dimensions["Resource efficiency"]).toMatchObject({ classes: { T: { penalty: 30 }, U: { penalty: 17 } } });
  expect(dimensions["Resource efficiency"].score).toBe(round((100 * 170) / 200 / 2 + (100 * 170) / 187 / 2));
});

test("scores resource efficiency with an overridden half-score penalty", () => {
  variants({ compiled: true, success: true }, { compiled: true, success: true });
  const efficiency = (halfScores?: Record<string, number>) => score(undefined, halfScores).dimensions!.find((d) => d.name === "Resource efficiency")!.score;
  expect(efficiency()).toBe(round((100 * 170) / 200));
  expect(efficiency({ "Resource efficiency": 30 })).toBe(50);
});

test("counts a variant with an uncaught exception as one failing test", () => {
  variants({ compiled: true, success: false }, { compiled: true, success: true });
  expect(score().dimensions!.find((d) => d.name === "Tests passing")).toMatchObject({ testsRan: 3, failing: 1 });
});

test("gates on a variant that does not compile", () => {
  variants({ compiled: true, success: true }, { variant: "headroom", compiled: false, success: false, compileProblem: "Unexpected token" });
  expect(score()).toEqual({ gated: true, gate: "compile", gateDetail: "headroom: Unexpected token", overall: 0 });
});

test("without a deploy, gates on tests that did not run and otherwise scores", () => {
  const opts = { app: [], test: [], run: RUN, root: RUN, headroomTest: [], skipDeploy: true, weights: { PMD: 0, "Graph Engine": 0, "Code coverage": 0, "Limit headroom": 0, "Resource efficiency": 0 } };
  writeFileSync(join(RUN, "tests.json"), JSON.stringify({ message: "no org" }));
  expect(scoreRun(opts)).toMatchObject({ gated: true, gate: "tests" });
  writeFileSync(join(RUN, "tests.json"), JSON.stringify({ result: { summary: { testsRan: 2, passing: 1, failing: 1, testExecutionTime: "0 ms" } } }));
  expect(scoreRun(opts)).toMatchObject({ gated: false, overall: 75 });
});

test("drops a namespace from test names in debug logs", () => {
  rmSync(join(RUN, "logs"), { recursive: true });
  mkdirSync(join(RUN, "logs"));
  writeFileSync(join(RUN, "logs/test.log"), `|CODE_UNIT_STARTED|[EXTERNAL]|01p|ns.T.headroom()\n|TESTING_LIMITS\n|LIMIT_USAGE_FOR_NS|(default)|\n  Maximum CPU time: 2500 out of 10000\n\n`);
  const weights = { PMD: 0, "Graph Engine": 0, "Tests passing": 0, "Code coverage": 0, "Test run time": 0, "Resource efficiency": 0 };
  expect(scoreRun({ app: [], test: [], run: RUN, root: RUN, headroomTest: ["T.headroom"], skipDeploy: true, weights }).overall).toBe(75);
});
