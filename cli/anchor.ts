import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Command } from "commander";
import { AscentDefaults, ascentDir, assertScratchOrg, loadConfig, REPO_ROOT, run } from "./lib/ascent.ts";
import { AuditReply, auditDir, auditErrors, auditPrompt, prepareAudit } from "./lib/audit.ts";
import { writeReview } from "./lib/review.ts";
import { prepareVerify, runScenarios, verifiable, verifyDir, verifyPrompt } from "./lib/verify.ts";

const program = new Command()
  .name("anchor")
  .description("The anchor steps that fix tests, code and spec from a scout ascent (doc/anchor.md)");

/** Runs an agent step from the ascent config, or the committed defaults, recording its prompt and output in dir. */
function runAgent(name: string, kind: "audit" | "verify", dir: string, prompt: string) {
  const defaults = AscentDefaults.parse(JSON.parse(readFileSync(join(REPO_ROOT, "ascent.config.json"), "utf8")));
  const step = loadConfig(name).steps[kind] ?? defaults.steps[kind];
  if (!step) throw new Error(`No ${kind} step in the ascent config or ascent.config.json`);
  writeFileSync(join(dir, "prompt.md"), prompt);
  const result = run("sh", ["-c", step.command], REPO_ROOT, prompt, { MODEL: step.model });
  writeFileSync(join(dir, "agent.txt"), result.stdout + result.stderr);
  if (result.status !== 0) throw new Error(`${kind} step exited ${result.status}, see ${join(dir, "agent.txt")}`);
}

/** Checks a findings file against the audit's input folder, returning the errors and, when it parses, the findings. */
function checkFindings(file: string, input: string): { errors: string[]; reply?: AuditReply } {
  try {
    const parsed = AuditReply.safeParse(JSON.parse(readFileSync(file, "utf8")));
    if (!parsed.success) return { errors: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) };
    return { errors: auditErrors(parsed.data, input), reply: parsed.data };
  } catch (error) {
    return { errors: [(error as Error).message] };
  }
}

const counts = (reply: AuditReply) =>
  Object.fromEntries(Object.entries(Object.groupBy(reply.findings, (f) => f.kind)).map(([k, v]) => [k, v!.length]));

program
  .command("check-findings")
  .description("Validate an audit's findings JSON: its shape, ids and links, verdicts, and file:line references into the input folder")
  .argument("<findings>", "the findings JSON file")
  .requiredOption("-i, --input <dir>", "the audit's input folder")
  .action((findings: string, opts: { input: string }) => {
    const { errors, reply } = checkFindings(findings, opts.input);
    if (errors.length) {
      console.log(JSON.stringify({ ok: false, errors }, null, 2));
      process.exitCode = 1;
      return;
    }
    console.log(JSON.stringify({ ok: true, findings: counts(reply!) }));
  });

program
  .command("audit")
  .description("Find where the baseline code, final code, tests and spec disagree: an agent writes findings, then the harness checks them")
  .argument("<name>", "ascent name")
  .option("-s, --spec <file>", "the spec the code should meet")
  .option("--no-agent", "rewrite the inputs and check the existing findings without the agent step")
  .action((name: string, opts: { spec?: string; agent: boolean }) => {
    const input = prepareAudit(loadConfig(name), opts.spec && resolve(opts.spec));
    const dir = auditDir(name);
    const out = join(dir, "findings.json");
    if (opts.agent) {
      rmSync(out, { force: true });
      runAgent(name, "audit", dir, auditPrompt(name));
    }
    const { errors, reply } = checkFindings(out, input);
    if (errors.length) {
      console.log(JSON.stringify({ ok: false, findings: out, errors }, null, 2));
      process.exitCode = 1;
      return;
    }
    console.log(JSON.stringify({ ok: true, findings: out, counts: counts(reply!) }, null, 2));
  });

program
  .command("verify")
  .description(
    "Reproduce each behaviour change: an agent writes a scenario per finding, then Streamline runs the baseline and final code on it"
  )
  .argument("<name>", "ascent name")
  .option("-f, --findings <file>", "the audit's findings JSON file, by default the one audit wrote")
  .option("--no-agent", "rerun the existing scenarios without the agent step")
  .action(async (name: string, opts: { findings?: string; agent: boolean }) => {
    const config = loadConfig(name);
    assertScratchOrg(config.targetOrg);
    const reply = AuditReply.parse(JSON.parse(readFileSync(opts.findings ?? join(auditDir(name), "findings.json"), "utf8")));
    const dir = prepareVerify(config, reply.findings);
    if (opts.agent) {
      for (const file of ["scenarios.apex", "skipped.json"]) rmSync(join(dir, file), { force: true });
      runAgent(name, "verify", dir, verifyPrompt(name));
    }
    const results = await runScenarios(
      config,
      verifiable(reply.findings).map((f) => f.id)
    );
    const byId = new Map(results.map(({ id, ...verify }) => [id, verify]));
    const findings = reply.findings.map((f) => (byId.has(f.id) ? { ...f, verify: byId.get(f.id) } : f));
    const out = join(ascentDir(name), "anchor", "findings.json");
    writeFileSync(out, JSON.stringify({ ...reply, findings }, null, 2) + "\n");
    console.log(JSON.stringify({ findings: out, results: results.map(({ id, status, problem }) => ({ id, status, problem })) }, null, 2));
  });

program
  .command("run-scenario")
  .description("Run verify scenarios with Streamline and print each version's outputs. The verify agent runs it on its own scenarios")
  .argument("<name>", "ascent name")
  .argument("<ids...>", "finding ids, each with a Scenario_<id> class in the verify folder's scenarios.apex")
  .action(async (name: string, ids: string[]) => {
    const config = loadConfig(name);
    assertScratchOrg(config.targetOrg);
    const results = await runScenarios(config, ids);
    console.log(JSON.stringify({ scenarios: join(verifyDir(name), "scenarios.apex"), results }, null, 2));
    if (results.some((r) => r.status === "error")) process.exitCode = 1;
  });

program
  .command("review")
  .description("Write the anchor's review page from its findings to target/ascents/<name>/anchor/review.html")
  .argument("<name>", "ascent name")
  .option("-f, --findings <file>", "the findings JSON file, by default the one verify wrote")
  .option("--open", "open the page in the default browser")
  .action((name: string, opts: { findings?: string; open?: boolean }) => {
    const out = writeReview(name, opts.findings);
    console.log(out);
    if (opts.open) run(process.platform === "darwin" ? "open" : "xdg-open", [out], REPO_ROOT);
  });

await program.parseAsync();
