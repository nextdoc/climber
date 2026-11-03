import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { collected, sliceRun } from "./map-run.ts";

const method = (cls: string, MethodName: string, Outcome: string, RunTime: number) => ({ ApexClass: { Name: cls, NamespacePrefix: "ns" }, MethodName, Outcome, RunTime });

const record = (testClass: string, cls: string, coveredLines: number[], uncoveredLines: number[]) => ({
  ApexTestClass: { Name: testClass },
  ApexClassOrTrigger: { Name: cls },
  Coverage: { coveredLines, uncoveredLines }
});

const RESULT = {
  summary: { testsRan: 4 },
  tests: [method("ATest", "one", "Pass", 100), method("ATest", "two", "Fail", 50), method("BTest", "one", "Pass", 10)],
  setup: [{ ApexClass: { Name: "ATest" }, MethodName: "setup", Message: null, TestSetupTime: 200 }],
  coverage: {
    coverage: [
      { name: "A", totalLines: 10 },
      { name: "B", totalLines: 4 }
    ],
    records: [record("ATest", "A", [1, 2], [3]), record("ATest", "A", [2, 3, 4], []), record("BTest", "A", [5], []), record("BTest", "B", [1], [2])]
  }
};

const violation = (file: string) => ({ engine: "pmd", rule: "R", message: "m", severity: 3, primaryLocationIndex: 0, locations: [{ file, startLine: 1 }] });

const log = (test: string) => `x|CODE_UNIT_STARTED|[EXTERNAL]|01p|${test}()\n`;

function slice() {
  mkdirSync(join(process.cwd(), "target/tmp"), { recursive: true });
  const dir = mkdtempSync(join(process.cwd(), "target/tmp/map-run-"));
  const run = join(dir, "run");
  mkdirSync(join(run, "logs"), { recursive: true });
  writeFileSync(join(run, "tests.json"), JSON.stringify({ result: RESULT }));
  writeFileSync(join(run, "pmd.json"), JSON.stringify({ violations: [violation("classes/A.cls"), violation(join(dir, "classes/B.cls"))] }));
  writeFileSync(join(run, "logs/1.log"), log("ns.ATest.setup"));
  writeFileSync(join(run, "logs/2.log"), log("BTest.one"));
  const groups = [
    { id: "a", tests: ["ATest"], app: ["classes/A.cls"] },
    { id: "b", tests: ["BTest"], app: ["classes/B.cls"] },
    { id: "c", tests: [], app: ["classes/C.cls"] }
  ];
  sliceRun(run, dir, groups, join(dir, "runs"));
  const read = (id: string, file: string) => JSON.parse(readFileSync(join(dir, "runs", id, file), "utf8"));
  return { dir, read };
}

test("sliceRun gives each group its own tests, setup, coverage, violations and logs", () => {
  const { dir, read } = slice();
  expect(read("a", "tests.json").result).toEqual({
    summary: { testsRan: 3, passing: 2, failing: 1, testExecutionTime: "350 ms" },
    coverage: { coverage: [{ name: "A", totalLines: 10, totalCovered: 4 }] }
  });
  expect(read("b", "tests.json").result.coverage.coverage).toEqual([
    { name: "A", totalLines: 10, totalCovered: 1 },
    { name: "B", totalLines: 4, totalCovered: 1 }
  ]);
  expect(read("a", "pmd.json").violations).toHaveLength(1);
  expect(read("b", "pmd.json").violations[0].locations[0].file).toBe(join(dir, "classes/B.cls"));
  expect(readdirSync(join(dir, "runs/a/logs"))).toEqual(["1.log"]);
  expect(readdirSync(join(dir, "runs/b/logs"))).toEqual(["2.log"]);
  expect(existsSync(join(dir, "runs/c/tests.json"))).toBe(false);
  expect(read("c", "pmd.json").violations).toEqual([]);
});

test("collected needs a run that covers every test, target and input", () => {
  const { dir } = slice();
  const run = join(dir, "run");
  const skip = { pmd: false, sfge: true, tests: false, logs: false };
  expect(collected(run, { tests: [], targets: [], skip })).toBe(false);
  writeFileSync(join(run, "collected.json"), JSON.stringify({ tests: ["ATest", "BTest"], targets: ["a"], skip }));
  expect(collected(run, { tests: ["ATest"], targets: ["a"], skip })).toBe(true);
  expect(collected(run, { tests: ["CTest"], targets: ["a"], skip })).toBe(false);
  expect(collected(run, { tests: ["ATest"], targets: ["a"], skip: { ...skip, sfge: false } })).toBe(false);
});
