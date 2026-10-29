import { describe, expect, test } from "bun:test";
import { AscentConfig, atSummit, consecutiveDiscards, decide, HistoryEntry, plateauDiscards } from "./ascent.ts";
import { DIMENSION_NAMES, type ScoreResult } from "./scoring.ts";

const baseline = Object.fromEntries(DIMENSION_NAMES.map((d) => [d, 50]));
const margins = Object.fromEntries(DIMENSION_NAMES.map((d) => [d, 1]));

const candidate = (changes: Record<string, number>): ScoreResult => ({
  gated: false,
  overall: 0,
  dimensions: DIMENSION_NAMES.map((name) => ({ name, weight: 1, score: changes[name] ?? 50 }))
});

describe("decide", () => {
  test("keeps when the focus rises by more than its margin and nothing falls", () => {
    expect(decide(baseline, baseline, candidate({ PMD: 52 }), ["PMD"], margins).outcome).toBe("keep");
  });

  test("discards when the focus rises by no more than its margin", () => {
    expect(decide(baseline, baseline, candidate({ PMD: 51 }), ["PMD"], margins).outcome).toBe("discard");
  });

  test("discards when another dimension falls by more than its margin", () => {
    const result = decide(baseline, baseline, candidate({ PMD: 60, "Test run time": 48 }), ["PMD"], margins);
    expect(result.outcome).toBe("discard");
    expect(result.reasons[0]).toContain("Test run time fell");
  });

  test("tolerates a fall within the margin", () => {
    expect(decide(baseline, baseline, candidate({ PMD: 60, "Test run time": 49.5 }), ["PMD"], margins).outcome).toBe("keep");
  });

  test("discards when a dimension drops below half its best", () => {
    const best = { ...baseline, "Limit headroom": 90 };
    const result = decide(baseline, best, candidate({ PMD: 60, "Limit headroom": 44 }), ["PMD"], { ...margins, "Limit headroom": 10 });
    expect(result.outcome).toBe("discard");
    expect(result.reasons[0]).toContain("below half its best");
  });

  test("ignores a disabled dimension missing from the candidate", () => {
    const result = candidate({ PMD: 52 });
    result.dimensions = result.dimensions!.filter((d) => d.name !== "Graph Engine");
    expect(decide(baseline, { ...baseline, "Graph Engine": 100 }, result, ["PMD"], margins).outcome).toBe("keep");
  });

  test("reports a gated candidate with its detail", () => {
    const result = decide(baseline, baseline, { gated: true, gate: "compile", gateDetail: "Unexpected token", overall: 0 }, ["PMD"], margins);
    expect(result).toEqual({ outcome: "gated", reasons: ["gated by compile: Unexpected token"] });
  });

  test("keeps a missed focus when the overall rises by more than one dimension's margin can move it", () => {
    const result = decide(baseline, baseline, { ...candidate({ PMD: 50.5, "Limit headroom": 60 }), overall: 51.5 }, ["PMD"], margins, 50);
    expect(result.outcome).toBe("keep");
    expect(result.reasons[0]).toContain("overall rose 1.5");
  });

  test("discards a missed focus when the overall rises within one dimension's margin", () => {
    expect(decide(baseline, baseline, { ...candidate({ "Limit headroom": 51 }), overall: 50.1 }, ["PMD"], margins, 50).outcome).toBe("discard");
  });

  test("discards a rising overall when another dimension fell by more than its margin", () => {
    const result = decide(baseline, baseline, { ...candidate({ "Limit headroom": 70, PMD: 45 }), overall: 52 }, ["Graph Engine"], margins, 50);
    expect(result.outcome).toBe("discard");
  });
});

describe("consecutiveDiscards", () => {
  const entry = (outcome: HistoryEntry["outcome"], dryRun = false): HistoryEntry => ({ iteration: 0, at: "", outcome, dryRun });

  test("counts non-keeps since the last keep and ignores dry runs", () => {
    const history = [entry("baseline"), entry("discard"), entry("keep"), entry("gated"), entry("discard", true), entry("rejected")];
    expect(consecutiveDiscards(history)).toBe(2);
  });
});

describe("plateauDiscards", () => {
  const entry = (outcome: HistoryEntry["outcome"], scores?: Record<string, number>): HistoryEntry => ({
    iteration: 0,
    at: "",
    outcome,
    dryRun: false,
    focus: ["PMD"],
    scores
  });

  test("counts discards whose focus missed its margin, skips unscored entries and stops at a focus that rose", () => {
    const history = [
      entry("baseline", baseline),
      entry("discard", { ...baseline, PMD: 51 }),
      entry("discard", { ...baseline, PMD: 60, "Graph Engine": 40 }),
      entry("discard", { ...baseline, PMD: 50.5 }),
      entry("gated"),
      entry("discard", { ...baseline, PMD: 49 })
    ];
    expect(plateauDiscards(history, margins)).toBe(2);
  });
});

describe("atSummit", () => {
  test("is true only when every dimension is within its margin of 100", () => {
    const margins = { PMD: 0.5, "Limit headroom": 3, "Tests passing": 0 };
    expect(atSummit({ PMD: 100, "Limit headroom": 99, "Tests passing": 100 }, margins)).toBe(true);
    expect(atSummit({ PMD: 99.5, "Limit headroom": 97, "Tests passing": 100 }, margins)).toBe(true);
    expect(atSummit({ PMD: 100, "Limit headroom": 96, "Tests passing": 100 }, margins)).toBe(false);
    expect(atSummit({ PMD: 100, "Limit headroom": 100, "Tests passing": 99 }, margins)).toBe(false);
  });
});

describe("HistoryEntry", () => {
  const entry = { iteration: 1, at: "2026-10-26T00:00:00.000Z", outcome: "keep", dryRun: false };

  test("accepts scores for every dimension", () => {
    expect(HistoryEntry.safeParse({ ...entry, scores: baseline }).success).toBe(true);
  });

  test("accepts scores missing a disabled dimension", () => {
    const { PMD, ...rest } = baseline;
    expect(HistoryEntry.safeParse({ ...entry, scores: rest }).success).toBe(true);
  });

  test("rejects an unknown focus dimension", () => {
    expect(HistoryEntry.safeParse({ ...entry, focus: ["Style"] }).success).toBe(false);
  });
});

describe("AscentConfig", () => {
  const config = {
    name: "t",
    branch: "ascent/t",
    worktree: "/w",
    targetOrg: "org",
    createdAt: "2026-10-26T00:00:00.000Z",
    baseCommit: "0".repeat(40),
    app: ["a"],
    test: [],
    testClasses: { sample: ["ATest"], holdout: ["BTest"] },
    steps: Object.fromEntries(["plan", "implement", "learn"].map((s) => [s, { model: "m", command: 'claude -p --model "$MODEL"' }])),
    maxDiscards: 5,
    margins,
    headroomTest: "ATest.headroom"
  };

  const streamline = { classes: ["a"], scenarios: "s.apex", variants: { correctness: "new S().run();" } };
  const unavailableOff = { "Code coverage": 0, "Test run time": 0 };

  test("accepts disjoint sample and holdout classes", () => {
    expect(AscentConfig.safeParse(config).success).toBe(true);
  });

  test("rejects a class in both sample and holdout", () => {
    expect(AscentConfig.safeParse({ ...config, testClasses: { sample: ["ATest"], holdout: ["ATest"] } }).success).toBe(false);
  });

  test("accepts streamline mode with a streamline block and the unavailable dimensions off", () => {
    expect(AscentConfig.safeParse({ ...config, mode: "streamline", streamline, weights: unavailableOff }).success).toBe(true);
  });

  test("rejects streamline mode without a streamline block", () => {
    expect(AscentConfig.safeParse({ ...config, mode: "streamline", weights: unavailableOff }).success).toBe(false);
  });

  test("rejects streamline mode that weighs code coverage", () => {
    expect(AscentConfig.safeParse({ ...config, mode: "streamline", streamline, weights: { "Test run time": 0 } }).success).toBe(false);
  });
});

test("the committed ascent.config.json is valid", async () => {
  const { AscentDefaults, REPO_ROOT } = await import("./ascent.ts");
  const file = await Bun.file(`${REPO_ROOT}/ascent.config.json`).json();
  expect(AscentDefaults.safeParse(file).success).toBe(true);
});
