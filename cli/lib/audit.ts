import { copyFileSync, existsSync, globSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";
import { ascentDir, classFiles, editableFiles, git, loadHistory, REPO_ROOT, type AscentConfig } from "./ascent.ts";

export const AUDIT_PROMPT = join(REPO_ROOT, "cli/prompts/anchor-audit.md");

export const auditDir = (name: string) => join(ascentDir(name), "anchor", "audit");

export const Finding = z.object({
  id: z.string().regex(/^[BDUT]\d+$/),
  kind: z.enum(["B", "D", "U", "T"]),
  title: z.string().min(1),
  detail: z.string().min(1),
  evidence: z.array(z.string()).min(1),
  iterations: z.array(z.int()).default([]),
  inAscent: z.boolean(),
  verdict: z.enum(["regression", "fix", "unspecified"]).optional(),
  baseline: z.string().optional(),
  final: z.string().optional(),
  specRefs: z.array(z.string()).default([]),
  severity: z.enum(["high", "medium", "low"]),
  caughtByTests: z.boolean(),
  related: z.array(z.string()).default([]),
  proposedTest: z.object({
    scenario: z.string().min(1),
    seedData: z.array(z.string()),
    expectedFrom: z.enum(["baseline", "spec", "user"]),
    expected: z.string()
  }),
  verify: z
    .object({
      status: z.enum(["reproduced", "not reproduced", "skipped", "error"]),
      baseline: z.unknown().optional(),
      final: z.unknown().optional(),
      problem: z.string().optional()
    })
    .optional()
});

export const AuditReply = z.object({
  summary: z.string().min(1),
  findings: z.array(Finding)
});

export type Finding = z.infer<typeof Finding>;
export type AuditReply = z.infer<typeof AuditReply>;

const LOCATION = /^([^:]+):(\d+)(?:-(\d+))?$/;

/** Problems with a `file:line` or `file:start-end` reference to a file in the input folder. */
function locationErrors(ref: string, inputDir: string): string[] {
  const match = LOCATION.exec(ref);
  if (!match) return [`"${ref}" is not file:line or file:start-end`];
  const [, file, start, end] = match;
  const path = join(inputDir, file);
  if (!existsSync(path)) return [`"${ref}": ${file} is not an input file`];
  const lines = readFileSync(path, "utf8").split("\n").length;
  const last = Number(end ?? start);
  if (Number(start) < 1 || last < Number(start) || last > lines) return [`"${ref}": ${file} has ${lines} lines`];
  return [];
}

/** Every rule the reply breaks beyond its shape. An empty list means the findings are valid. */
export function auditErrors(reply: AuditReply, inputDir: string): string[] {
  const errors: string[] = [];
  const hasSpec = existsSync(join(inputDir, "spec.md"));
  const iterationsPath = join(inputDir, "iterations.jsonl");
  const iterations = new Set(
    existsSync(iterationsPath)
      ? readFileSync(iterationsPath, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => (JSON.parse(line) as { iteration: number }).iteration)
      : []
  );
  const byId = new Map<string, Finding>();
  for (const f of reply.findings) {
    if (byId.has(f.id)) errors.push(`${f.id}: duplicate id`);
    byId.set(f.id, f);
  }
  const linked = (a: Finding, b: Finding) => a.related.includes(b.id) || b.related.includes(a.id);

  for (const f of reply.findings) {
    const at = (message: string) => errors.push(`${f.id}: ${message}`);
    if (!f.id.startsWith(f.kind)) at(`the id must start with its kind, ${f.kind}`);
    for (const id of f.related) {
      if (id === f.id) at("relates to itself");
      else if (!byId.has(id)) at(`related id ${id} does not exist`);
    }
    for (const ref of f.evidence) locationErrors(ref, inputDir).forEach((e) => at(`evidence ${e}`));
    for (const n of f.iterations) if (!iterations.has(n)) at(`iteration ${n} is not in iterations.jsonl`);
    for (const ref of f.specRefs) locationErrors(ref, inputDir).forEach((e) => at(`specRefs ${e}`));

    if (f.kind === "B" && !f.verdict) at("a B needs a verdict");
    if (f.kind === "B" && (!f.baseline || !f.final)) at("a B needs what the baseline and the final code each do");
    if (f.kind !== "B" && f.verdict) at(`only a B has a verdict, this is a ${f.kind}`);
    if ((f.verdict === "regression" || f.verdict === "fix") && f.specRefs.length === 0)
      at(`a ${f.verdict} must cite the spec line that decides it in specRefs`);
    if (f.verdict === "unspecified" && ![...byId.values()].some((u) => u.kind === "U" && linked(f, u)))
      at("an unspecified B must link to a U");
    if (f.kind === "D" && f.inAscent) at("a D is behaviour both versions share, so inAscent must be false");
    if (!hasSpec && f.kind === "D") at("there is no spec, so there are no D findings");
    if (!hasSpec && f.verdict && f.verdict !== "unspecified") at("there is no spec, so every B is unspecified");
    if (f.proposedTest.expectedFrom !== "user" && !f.proposedTest.expected)
      at(`the expected result is set by the ${f.proposedTest.expectedFrom}, so state it`);
  }
  return errors;
}

/** A prompt document's text block, the part the agent is given. */
export function promptText(file: string): string {
  const text = /```text\n([\s\S]*?)\n```/.exec(readFileSync(file, "utf8"))?.[1];
  if (!text) throw new Error(`${file} has no text block`);
  return text;
}

/** Writes the audit's inputs from the worktree and history, replacing any earlier ones, and returns the input folder. */
export function prepareAudit(config: AscentConfig, spec?: string): string {
  const input = join(auditDir(config.name), "input");
  rmSync(input, { recursive: true, force: true });
  for (const dir of ["baseline", "final", "tests"]) mkdirSync(join(input, dir), { recursive: true });
  const show = (ref: string, file: string) => git(config.worktree, "show", `${ref}:${file}`);
  const apps = [...editableFiles(config)].filter((f) => f.endsWith(".cls")).sort();
  for (const f of apps) {
    writeFileSync(join(input, "baseline", basename(f)), show(config.baseCommit, f) + "\n");
    writeFileSync(join(input, "final", basename(f)), show("HEAD", f) + "\n");
  }
  const tests = new Set([
    ...config.test.flatMap((p) => globSync(p, { cwd: config.worktree })),
    ...classFiles(config.worktree, config.testClasses.holdout)
  ]);
  for (const f of [...tests].filter((f) => f.endsWith(".cls"))) writeFileSync(join(input, "tests", basename(f)), show("HEAD", f) + "\n");
  writeFileSync(join(input, "diff.patch"), git(config.worktree, "diff", config.baseCommit, "HEAD", "--", ...apps) + "\n");
  const iterations = loadHistory(config.name)
    .filter((e) => !e.dryRun && e.outcome !== "baseline")
    .map(({ iteration, outcome, focus, reason, edits, decision, learning }) =>
      JSON.stringify({ iteration, outcome, focus, reason, edits, decision, learning })
    );
  writeFileSync(join(input, "iterations.jsonl"), iterations.join("\n") + "\n");
  if (spec) copyFileSync(spec, join(input, "spec.md"));
  return input;
}

/** The audit prompt's text block with its placeholders filled in. */
export function auditPrompt(name: string): string {
  return promptText(AUDIT_PROMPT)
    .replaceAll("INPUT_DIR", join(auditDir(name), "input"))
    .replaceAll("OUTPUT_FILE", join(auditDir(name), "findings.json"));
}
