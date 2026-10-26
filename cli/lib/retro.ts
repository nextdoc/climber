import { readFileSync } from "node:fs";
import { matchesGlob } from "node:path";
import { z } from "zod";
import { classFiles, editableFiles, git, kept, type AscentConfig, type HistoryEntry } from "./ascent.ts";

const Item = z.object({ title: z.string().min(1), detail: z.string().min(1) });

/** The agent's reply. Fixed lists constrain the shape, the free text in each item carries the content. */
export const RetroReply = z.object({
  summary: z.string().min(1),
  behaviourChanges: z.array(
    Item.extend({
      evidence: z.string(),
      iterations: z.array(z.int()).default([]),
      severity: z.enum(["high", "medium", "low"]),
      caughtByTests: z.boolean(),
      proposedTest: z.string().optional()
    })
  ),
  patterns: z.array(Item.extend({ evidence: z.string(), verdict: z.enum(["good", "questionable", "bad"]) })),
  testGaps: z.array(Item.extend({ proposedTest: z.string().min(1) })),
  other: z.array(Item).default([])
});

export type RetroReply = z.infer<typeof RetroReply>;

const PREFIXES = { behaviourChanges: "B", patterns: "P", testGaps: "T", other: "X" } as const;

/** Numbers every item per list (B1, P1, T1, X1), so references stay stable across readers. */
export function withCodes(reply: RetroReply) {
  const coded = <T>(items: T[], prefix: string) => items.map((item, i) => ({ code: `${prefix}${i + 1}`, ...item }));
  return {
    summary: reply.summary,
    behaviourChanges: coded(reply.behaviourChanges, PREFIXES.behaviourChanges),
    patterns: coded(reply.patterns, PREFIXES.patterns),
    testGaps: coded(reply.testGaps, PREFIXES.testGaps),
    other: coded(reply.other, PREFIXES.other)
  };
}

/** The fixed inputs of a retrospective, all computed from the worktree and history. */
export function retroInputs(config: AscentConfig, history: HistoryEntry[], specs: string[]) {
  const states = kept(history);
  const base = states[0].commit!;
  const head = git(config.worktree, "rev-parse", "HEAD");
  const changed = git(config.worktree, "diff", "--name-only", base, head).split("\n").filter(Boolean);
  const editable = editableFiles(config);
  const holdout = new Set(classFiles(config.worktree, config.testClasses.holdout));
  return {
    base,
    head,
    baselineScores: states[0].scores!,
    currentScores: states.at(-1)!.scores!,
    changedApplication: changed.filter((f) => editable.has(f)),
    changedTests: changed.filter((f) => holdout.has(f) || config.test.some((g) => matchesGlob(f, g))),
    diff: git(config.worktree, "diff", base, head, "--", ...[...editable].filter((f) => f.endsWith(".cls"))),
    testFiles: classFiles(config.worktree, [...config.testClasses.sample, ...config.testClasses.holdout]).filter((f) =>
      f.endsWith(".cls")
    ),
    iterations: history
      .filter((e) => !e.dryRun && e.outcome !== "baseline")
      .map(({ iteration, outcome, focus, reason, edits, decision, learning }) => ({
        iteration,
        outcome,
        focus,
        reason,
        edits,
        decision,
        learning
      })),
    specs: specs.map((path) => ({ path, text: readFileSync(path, "utf8") }))
  };
}

export type RetroInputs = ReturnType<typeof retroInputs>;

export function retroPrompt(inputs: RetroInputs): string {
  const specs = inputs.specs.length
    ? inputs.specs.map((s) => `--- ${s.path}\n${s.text}`).join("\n")
    : "None given. Infer the intended behaviour from the baseline code and the tests.";
  return `You are the retrospective step at the end of an ascent that improved Salesforce Apex code by hill climbing.
Each iteration kept a change when its scores rose and every test still passed. The climb optimised scores, not business behaviour,
so anything the tests do not pin down may have changed. Review the evolved code against the baseline and the requirements.
Read any file in the worktree, but do not edit any file.

Baseline commit ${inputs.base}, evolved commit ${inputs.head}.
Application files changed: ${inputs.changedApplication.join(", ") || "none"}
Test and fixture files changed: ${inputs.changedTests.join(", ") || "none"}
Test classes: ${inputs.testFiles.join(", ")}
Scores, baseline then evolved: ${JSON.stringify(inputs.baselineScores)} ${JSON.stringify(inputs.currentScores)}

Requirements:
${specs}

Iterations, with each plan's reason, the decision and the learning:
${JSON.stringify(inputs.iterations, null, 1)}

Diff of the application classes from baseline to evolved:
${inputs.diff}

Report:
- behaviourChanges: every way the evolved code behaves differently from the baseline or the requirements, including cases the tests do not run:
  platform semantics of fields and queries it now relies on, sharing and user-mode access, governor limits at larger volumes, nulls and edge cases.
  Name the iterations that introduced each one, and say whether an existing test would fail if it were wrong.
- patterns: notable coding patterns the ascent introduced or kept, with a verdict of good, questionable or bad.
- testGaps: behaviour the tests do not pin down, each with a proposed test.
- other: anything useful that fits none of the above.
Give evidence as file:line or iteration numbers. Do not number the items.

End your reply with one JSON object and nothing after it:
{"summary": "two or three sentences", "behaviourChanges": [{"title": "", "detail": "", "evidence": "", "iterations": [1], "severity": "high|medium|low", "caughtByTests": false, "proposedTest": ""}],
 "patterns": [{"title": "", "detail": "", "evidence": "", "verdict": "good|questionable|bad"}], "testGaps": [{"title": "", "detail": "", "proposedTest": ""}], "other": [{"title": "", "detail": ""}]}
`;
}
