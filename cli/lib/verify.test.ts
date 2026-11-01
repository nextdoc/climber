import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Finding } from "./audit.ts";
import type { VariantResult } from "./streamline.ts";
import { findingTarget, scenarioResult, skipReasons, verifyOutput, type VerifyTarget, type Version } from "./verify.ts";

test("reads one version's outputs from its debug log, decoding Streamline's escapes", () => {
  const log = [
    "16:02:23.13 (1)|USER_DEBUG|[537]|DEBUG|VERIFY&#124;f1&#124;SEEDED",
    "16:02:23.13 (2)|USER_DEBUG|[539]|DEBUG|VERIFY&#124;f1&#124;FINAL&#124;{&quot;rating&quot;:&quot;Warm&quot;}"
  ].join("\n");
  expect(verifyOutput(log, "f1", "final")).toEqual({ seeded: true, output: '{"rating":"Warm"}' });
  expect(verifyOutput(log, "f1", "baseline")).toEqual({ seeded: true, output: undefined });
  expect(verifyOutput(log, "f11", "final")).toEqual({ seeded: false, output: undefined });
});

test("reads the agent's skip reasons, and none when it wrote no skipped.json", () => {
  const dir = mkdtempSync(join(tmpdir(), "verify-"));
  expect(skipReasons(dir)).toEqual(new Map());
  writeFileSync(join(dir, "skipped.json"), JSON.stringify({ skipped: [{ id: "f5", reason: "depends on sharing" }] }));
  expect(skipReasons(dir)).toEqual(new Map([["f5", "depends on sharing"]]));
});

describe("findingTarget", () => {
  const target = (name: string, ...apps: string[]): VerifyTarget => ({ name, dir: name, apps, support: [] });
  const account = target("A", "classes/AccountHealthRollup.cls");
  const caseSla = target("C", "classes/CaseSlaEscalation.cls", "classes/AccountHealthRollup.cls");
  const cites = (...evidence: string[]) => ({ evidence }) as Finding;

  test("routes a finding to the target that climbs every class its evidence cites", () => {
    expect(findingTarget(cites("final/AccountHealthRollup.cls:12"), [account, caseSla])).toBe(account);
    expect(findingTarget(cites("final/CaseSlaEscalation.cls:3", "baseline/AccountHealthRollup.cls:9"), [account, caseSla])).toBe(caseSla);
  });

  test("falls back to a target that climbs some cited class, and to none", () => {
    expect(findingTarget(cites("final/CaseSlaEscalation.cls:3", "tests/CaseFixtures.cls:4"), [account, caseSla])).toBe(caseSla);
    expect(findingTarget(cites("tests/CaseFixtures.cls:4"), [account, caseSla])).toBeUndefined();
  });

  test("routes every finding to a single target", () => {
    expect(findingTarget(cites("tests/CaseFixtures.cls:4"), [account])).toBe(account);
  });
});

describe("scenarioResult", () => {
  const run = (variant: string, over: Partial<VariantResult> = {}): VariantResult => ({
    variant,
    compiled: true,
    success: true,
    compileProblem: null,
    exception: null,
    executionMs: 1,
    ...over
  });
  const logs =
    (outputs: Partial<Record<Version, string>>, seeded = true) =>
    (v: Version) =>
      [seeded ? "|DEBUG|VERIFY|B1|SEEDED" : "", outputs[v] ? `|DEBUG|VERIFY|B1|${v.toUpperCase()}|${outputs[v]}` : ""].join("\n");
  const both = [run("B1.baseline"), run("B1.final")];

  test("reproduced when the versions' outputs differ, not reproduced when they match", () => {
    expect(scenarioResult("B1", both, logs({ baseline: '{"n":1}', final: '{"n":2}' }))).toEqual({
      id: "B1",
      status: "reproduced",
      baseline: { n: 1 },
      final: { n: 2 }
    });
    expect(scenarioResult("B1", both, logs({ baseline: '{"n":1}', final: '{"n":1}' })).status).toBe("not reproduced");
  });

  test("records an uncaught exception after seeding as that version's output", () => {
    const limit = run("B1.final", { success: false, exception: { type: "System.LimitException", message: "Too many SOQL queries: 101" } });
    expect(scenarioResult("B1", [run("B1.baseline"), limit], logs({ baseline: '{"n":1}' }))).toMatchObject({
      status: "reproduced",
      final: { uncaught: "System.LimitException: Too many SOQL queries: 101" }
    });
  });

  test("errors when a version did not compile, did not run, failed to seed or logged no output", () => {
    const compileError = [run("B1.baseline", { compiled: false, compileProblem: "line 3" })];
    expect(scenarioResult("B1", compileError, logs({})).problem).toBe("compile: line 3");
    expect(scenarioResult("B1", [], logs({})).problem).toBe("not run, because an earlier scenario failed to compile");
    const seedFail = [run("B1.baseline", { success: false, exception: { type: "DmlException", message: "x" } })];
    expect(scenarioResult("B1", seedFail, logs({}, false)).problem).toBe("seed: DmlException: x");
    expect(scenarioResult("B1", both, logs({ baseline: '{"n":1}' })).problem).toBe("no final output in the debug log");
  });
});
