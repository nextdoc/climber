import { existsSync, globSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";
import { ascentDir, editableFiles, git, MCP_CONFIG, REPO_ROOT, type AscentConfig } from "./ascent.ts";
import { promptText, type Finding } from "./audit.ts";
import { extract } from "./extract.ts";
import { runVariants, type VariantResult } from "./streamline.ts";

export const VERIFY_PROMPT = join(REPO_ROOT, "cli/prompts/anchor-verify.md");

export const verifyDir = (name: string) => join(ascentDir(name), "anchor", "verify");

const VERSIONS = ["baseline", "final"] as const;
export type Version = (typeof VERSIONS)[number];

export type ScenarioResult = {
  id: string;
  status: "reproduced" | "not reproduced" | "skipped" | "error";
  baseline?: unknown;
  final?: unknown;
  problem?: string;
};

const Skipped = z.object({ skipped: z.array(z.object({ id: z.string(), reason: z.string().min(1) })) });

/** The agent's reason for each finding it wrote no scenario for, from skipped.json. */
export function skipReasons(dir: string): Map<string, string> {
  const file = join(dir, "skipped.json");
  if (!existsSync(file)) return new Map();
  return new Map(Skipped.parse(JSON.parse(readFileSync(file, "utf8"))).skipped.map((s) => [s.id, s.reason]));
}

/** Verify compares the two versions, so it applies to behaviour changes only. */
export const verifiable = (findings: Finding[]) => findings.filter((f) => f.kind === "B");

/** Writes the verify step's inputs: the baseline classes renamed with a Baseline suffix, the final classes and the fixtures, and the findings. */
export function prepareVerify(config: AscentConfig, findings: Finding[]): string {
  const dir = verifyDir(config.name);
  mkdirSync(join(dir, "input"), { recursive: true });
  const apps = [...editableFiles(config)].filter((f) => f.endsWith(".cls")).sort();
  const names = apps.map((f) => basename(f, ".cls"));
  const rename = (text: string) => names.reduce((t, n) => t.replace(new RegExp(`\\b${n}\\b`, "g"), `${n}Baseline`), text);
  const testClasses = new Set([...config.testClasses.sample, ...config.testClasses.holdout]);
  const fixtures = [...new Set(config.test.flatMap((p) => globSync(p, { cwd: config.worktree })))]
    .filter((f) => f.endsWith(".cls") && !testClasses.has(basename(f, ".cls")))
    .sort();
  const show = (ref: string, file: string) => git(config.worktree, "show", `${ref}:${file}`);
  const classes = [
    ...apps.map((f) => extract(`${basename(f, ".cls")}Baseline.cls`, rename(show(config.baseCommit, f))).code),
    ...apps.map((f) => extract(f, show("HEAD", f)).code),
    ...fixtures.map((f) => extract(f, show("HEAD", f)).code)
  ];
  writeFileSync(join(dir, "input", "classes.apex"), classes.join("\n\n") + "\n");
  writeFileSync(join(dir, "input", "findings.json"), JSON.stringify({ findings: verifiable(findings) }, null, 2) + "\n");
  return dir;
}

/** The prompt's text block from cli/prompts/anchor-verify.md, with its placeholders filled in. */
export function verifyPrompt(name: string): string {
  const dir = verifyDir(name);
  return promptText(VERIFY_PROMPT)
    .replaceAll("INPUT_DIR", join(dir, "input"))
    .replaceAll("OUTPUT_FILE", join(dir, "scenarios.apex"))
    .replaceAll("SKIP_FILE", join(dir, "skipped.json"))
    .replaceAll("RUN_COMMAND", `bun cli/anchor.ts run-scenario ${name}`);
}

/** One script per scenario and version, so each version runs in its own transaction with its own governor limits. */
export function scenarioScript(classes: string, scenarios: string, id: string, version: Version): string {
  return `// === CLASSES ===
${classes}
${scenarios}
// === CODE ===
Scenario_${id} s = new Scenario_${id}();
s.seed();
System.debug('VERIFY|${id}|SEEDED');
s.${version === "baseline" ? "runBaseline" : "runFinal"}();
System.debug('VERIFY|${id}|${version.toUpperCase()}|' + JSON.serialize(s.capture()));
`;
}

/** Whether a version's script got past seed(), and the outputs it logged. Streamline escapes | and " in debug lines. */
export function verifyOutput(log: string, id: string, version: Version): { seeded: boolean; output?: string } {
  const decoded = log.replaceAll("&#124;", "|").replaceAll("&quot;", '"');
  const seeded = decoded.includes(`|DEBUG|VERIFY|${id}|SEEDED`);
  const tag = `|DEBUG|VERIFY|${id}|${version.toUpperCase()}|`;
  const line = decoded.split("\n").find((l) => l.includes(tag));
  return { seeded, output: line?.slice(line.indexOf(tag) + tag.length) };
}

/** Runs each scenario's two versions with Streamline and compares their outputs. */
export async function runScenarios(config: AscentConfig, ids: string[]): Promise<ScenarioResult[]> {
  const dir = verifyDir(config.name);
  const scenarios = readFileSync(join(dir, "scenarios.apex"), "utf8");
  const classes = readFileSync(join(dir, "input", "classes.apex"), "utf8");
  const runs = join(dir, "runs");
  mkdirSync(runs, { recursive: true });
  const reasons = skipReasons(dir);
  const present = ids.filter((id) => new RegExp(`\\bclass\\s+Scenario_${id}\\b`).test(scenarios));
  const variants = present.flatMap((id) => VERSIONS.map((v) => `${id}.${v}`));
  for (const id of present)
    for (const v of VERSIONS) writeFileSync(join(runs, `${id}.${v}.apex`), scenarioScript(classes, scenarios, id, v));
  const results = variants.length ? await runVariants(MCP_CONFIG, config.targetOrg, runs, variants) : [];
  const log = (id: string, v: Version) => {
    const file = join(runs, "logs", `${id}.${v}.log`);
    return existsSync(file) ? readFileSync(file, "utf8") : "";
  };
  return ids.map((id) =>
    present.includes(id)
      ? scenarioResult(id, results, (v) => log(id, v))
      : { id, status: "skipped", problem: reasons.get(id) ?? `scenarios.apex has no class Scenario_${id}` }
  );
}

/** Compares a scenario's two runs, given Streamline's results and each version's debug log. */
export function scenarioResult(id: string, results: VariantResult[], log: (v: Version) => string): ScenarioResult {
  const outputs: Partial<Record<Version, string>> = {};
  for (const v of VERSIONS) {
    const r = results.find((x) => x.variant === `${id}.${v}`);
    if (!r) return { id, status: "error", problem: "not run, because an earlier scenario failed to compile" };
    if (!r.compiled) return { id, status: "error", problem: `compile: ${r.compileProblem}` };
    const { seeded, output } = verifyOutput(log(v), id, v);
    const exception = `${r.exception?.type}: ${r.exception?.message}`;
    if (!seeded) return { id, status: "error", problem: r.success ? "no VERIFY output in the debug log" : `seed: ${exception}` };
    // An exception that escapes the scenario's catch, such as a LimitException, is this version's output.
    if (!r.success) outputs[v] = JSON.stringify({ uncaught: exception });
    else if (output === undefined) return { id, status: "error", problem: `no ${v} output in the debug log` };
    else outputs[v] = output;
  }
  const { baseline, final } = outputs as Record<Version, string>;
  return { id, status: baseline === final ? "not reproduced" : "reproduced", baseline: JSON.parse(baseline), final: JSON.parse(final) };
}
