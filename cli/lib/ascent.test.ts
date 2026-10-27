import { describe, expect, test } from "bun:test";
import { AscentConfig, consecutiveDiscards, decide, HistoryEntry } from "./ascent.ts";
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

  test("reports a gated candidate", () => {
    expect(decide(baseline, baseline, { gated: true, gate: "compile", overall: 0 }, ["PMD"], margins).outcome).toBe("gated");
  });
});

describe("consecutiveDiscards", () => {
  const entry = (outcome: HistoryEntry["outcome"], dryRun = false): HistoryEntry => ({ iteration: 0, at: "", outcome, dryRun });

  test("counts non-keeps since the last keep and ignores dry runs", () => {
    const history = [entry("baseline"), entry("discard"), entry("keep"), entry("gated"), entry("discard", true), entry("rejected")];
    expect(consecutiveDiscards(history)).toBe(2);
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
