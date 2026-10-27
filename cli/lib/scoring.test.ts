import { beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./ascent.ts";
import { scoreRun } from "./scoring.ts";

const RUN = join(REPO_ROOT, "target/tmp/scoring-test");

const log = (...lines: string[]) => lines.map((l, i) => `${i}\t12:00:00.0|USER_DEBUG|[1]|DEBUG|${l.replaceAll("|", "&#124;")}`).join("\n");

const limits = (cpu: number) => JSON.stringify({ "Maximum CPU time": { used: cpu, limit: 10000 } });

const score = () =>
  scoreRun({
    app: [],
    test: [],
    run: RUN,
    root: RUN,
    mode: "streamline",
    headroomTest: "T.headroom",
    weights: { PMD: 0, "Graph Engine": 0, "Code coverage": 0, "Test run time": 0 },
    runCounts: { "T.main": 3 }
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
  expect(dimensions["Limit headroom"]).toMatchObject({ test: "T.headroom", peakPercent: 40, score: 60 });
  expect(dimensions["Resource efficiency"].percentOfLimit).toEqual({ "Maximum CPU time": 30 });
});

test("counts a variant with an uncaught exception as one failing test", () => {
  variants({ compiled: true, success: false }, { compiled: true, success: true });
  expect(score().dimensions!.find((d) => d.name === "Tests passing")).toMatchObject({ testsRan: 3, failing: 1 });
});

test("gates on a variant that does not compile", () => {
  variants({ compiled: true, success: true }, { variant: "headroom", compiled: false, success: false, compileProblem: "Unexpected token" });
  expect(score()).toEqual({ gated: true, gate: "compile", gateDetail: "headroom: Unexpected token", overall: 0 });
});
