import { describe, expect, test } from "bun:test";
import { RetroReply, withCodes } from "./retro.ts";

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
