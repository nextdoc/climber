import { describe, expect, test } from "bun:test";
import { RetroReply, unitScores, withCodes } from "./retro.ts";

const item = (title: string) => ({ title, detail: "d" });

describe("withCodes", () => {
  test("numbers each list with its own prefix", () => {
    const reply = RetroReply.parse({
      summary: "s",
      behaviourChanges: [
        { ...item("a"), evidence: "e", severity: "high", caughtByTests: false },
        { ...item("b"), evidence: "e", severity: "low", caughtByTests: true }
      ],
      patterns: [{ ...item("c"), evidence: "e", verdict: "good" }],
      testGaps: [{ ...item("d"), proposedTest: "t" }]
    });
    const coded = withCodes(reply);
    expect(coded.behaviourChanges.map((i) => i.code)).toEqual(["B1", "B2"]);
    expect(coded.patterns[0].code).toBe("P1");
    expect(coded.testGaps[0].code).toBe("T1");
    expect(coded.other).toEqual([]);
  });
});

describe("unitScores", () => {
  test("keeps the per headroom test and per test class scores, rounded", () => {
    const dimensions = [
      { name: "PMD", weight: 1, score: 50 },
      { name: "Limit headroom", weight: 1, score: 60, tests: { "A.headroom": { score: 40.04 }, "B.headroom": { score: 80 } } },
      { name: "Resource efficiency", weight: 1, score: 30, classes: { ATest: { score: 12.66 }, BTest: { score: 47.3 } } }
    ];
    expect(unitScores({ gated: false, overall: 0, dimensions })).toEqual({
      "Limit headroom": { "A.headroom": 40, "B.headroom": 80 },
      "Resource efficiency": { ATest: 12.7, BTest: 47.3 }
    });
  });
});
