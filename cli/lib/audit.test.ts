import { beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./ascent.ts";
import { AuditReply, auditErrors, type Finding } from "./audit.ts";

const DIR = join(REPO_ROOT, "target/tmp/audit-test");
const NO_SPEC = join(DIR, "no-spec");

const finding = (over: Partial<Finding>): Finding =>
  AuditReply.parse({
    summary: "s",
    findings: [
      {
        id: `${over.kind ?? "T"}1`,
        kind: "T",
        title: "t",
        detail: "d",
        evidence: ["final/A.cls:2"],
        inAscent: false,
        severity: "low",
        caughtByTests: false,
        proposedTest: {
          scenario: "s",
          seedData: [],
          expectedFrom: "user",
          expected: ""
        },
        ...over
      }
    ]
  }).findings[0];

const errors = (findings: Finding[], dir = DIR) => auditErrors({ summary: "s", findings }, dir);

beforeAll(() => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(join(DIR, "final"), { recursive: true });
  mkdirSync(join(NO_SPEC, "final"), { recursive: true });
  for (const dir of [DIR, NO_SPEC]) {
    writeFileSync(join(dir, "final/A.cls"), "one\ntwo\nthree");
    writeFileSync(join(dir, "iterations.jsonl"), '{"iteration":1}\n{"iteration":2}\n');
  }
  writeFileSync(join(DIR, "spec.md"), "# Spec\nRule\n");
});

const b = (over: Partial<Finding> = {}) =>
  finding({
    kind: "B",
    verdict: "unspecified",
    baseline: "x",
    final: "y",
    inAscent: true,
    ...over
  });

describe("auditErrors", () => {
  test("accepts a valid set of findings", () => {
    expect(errors([b({ related: ["U1"] }), finding({ kind: "U" })])).toEqual([]);
  });

  test("rejects evidence outside the input files", () => {
    expect(
      errors([
        finding({
          evidence: ["final/A.cls:4", "final/B.cls:1", "A.cls line 2"]
        })
      ])
    ).toEqual([
      'T1: evidence "final/A.cls:4": final/A.cls has 3 lines',
      'T1: evidence "final/B.cls:1": final/B.cls is not an input file',
      'T1: evidence "A.cls line 2" is not file:line or file:start-end'
    ]);
  });

  test("rejects an id that does not start with its kind", () => {
    expect(errors([finding({ id: "B1" })])).toEqual(["B1: the id must start with its kind, T"]);
  });

  test("rejects duplicate ids, unknown links and unknown iterations", () => {
    expect(errors([finding({ related: ["T9"], iterations: [3] }), finding({})])).toEqual([
      "T1: duplicate id",
      "T1: related id T9 does not exist",
      "T1: iteration 3 is not in iterations.jsonl"
    ]);
  });

  test("requires a regression or fix to cite the spec, and an unspecified B to link to a U", () => {
    expect(errors([b({ verdict: "fix" }), b({ id: "B2" })])).toEqual([
      "B1: a fix must cite the spec line that decides it in specRefs",
      "B2: an unspecified B must link to a U"
    ]);
  });

  test("allows no D and no spec verdicts without a spec", () => {
    const d = finding({ kind: "D" });
    expect(errors([b({ verdict: "regression", specRefs: ["final/A.cls:1"] }), d], NO_SPEC)).toEqual([
      "B1: there is no spec, so every B is unspecified",
      "D1: there is no spec, so there are no D findings"
    ]);
  });

  test("keeps verdicts on B findings and D findings out of the ascent", () => {
    expect(
      errors([
        finding({
          kind: "D",
          verdict: "fix",
          inAscent: true,
          specRefs: ["spec.md:2"]
        })
      ])
    ).toEqual(["D1: only a B has a verdict, this is a D", "D1: a D is behaviour both versions share, so inAscent must be false"]);
  });
});
