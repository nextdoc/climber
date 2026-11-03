import { beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./lib/ascent.ts";

// Each CLI runs from a copy of the repo, because REPO_ROOT, and with it the worktrees and ascents, follows the CLI's location.
const SANDBOX = join(REPO_ROOT, "target/tmp/cli-test");
const REPO = join(SANDBOX, "repo");
const FAKE = join(SANDBOX, "fake");
const APP_CLASS = "force-app/main/default/classes/AccountHealthRollup.cls";
const ASCENT = join(REPO, "target/ascents/t");

const FAKE_SF = `#!/usr/bin/env bash
echo "$*" >> "$FAKE/calls.log"
case "$*" in
  "project deploy start"*) echo '{"result":{"success":true}}' ;;
  "code-analyzer run"*"--rule-selector pmd"*) cp "$FAKE/pmd.json" "\${@: -1}" ;;
  "code-analyzer run"*"--rule-selector sfge"*) cp "$FAKE/sfge.json" "\${@: -1}" ;;
  "apex run test"*) cat "$FAKE/tests.json" ;;
  "apex get log"*) cp "$FAKE/test.log" "\${@: -1}/test.log" ;;
  "org display"*) echo '{"result":{"username":"u"}}' ;;
  "data query"*) echo '{"result":{"records":[{"Id":"x"}]}}' ;;
  *) echo '{"result":{"id":"x"}}' ;;
esac
`;

const violation = { engine: "pmd", rule: "R", message: "m", severity: 3, primaryLocationIndex: 0, locations: [{ file: APP_CLASS, startLine: 1 }] };

const testMethod = (MethodName: string) => ({ ApexClass: { Name: "AccountHealthRollupTest" }, MethodName, Outcome: "Pass", RunTime: 2000 });

const TESTS = {
  result: {
    summary: { testsRan: 2, passing: 2, failing: 0, testExecutionTime: "4000 ms" },
    tests: [testMethod("headroomAt200Accounts"), testMethod("other")],
    coverage: {
      coverage: [{ name: "AccountHealthRollup", totalLines: 10, totalCovered: 9 }],
      records: [
        {
          ApexTestClass: { Name: "AccountHealthRollupTest" },
          ApexClassOrTrigger: { Name: "AccountHealthRollup" },
          Coverage: { coveredLines: [1, 2, 3, 4, 5, 6, 7, 8, 9], uncoveredLines: [10] }
        }
      ]
    }
  }
};

const testLog = (test: string) => `|CODE_UNIT_STARTED|[EXTERNAL]|01p|${test}()
|TESTING_LIMITS
|LIMIT_USAGE_FOR_NS|(default)|
  Number of SOQL queries: 10 out of 100
  Maximum CPU time: 1000 out of 10000

`;

const RETRO = {
  summary: "s",
  behaviourChanges: [{ title: "b", detail: "d", evidence: "e", severity: "low", caughtByTests: true }],
  patterns: [],
  testGaps: [{ title: "t", detail: "d", proposedTest: "p" }]
};

// Fake agents consume the prompt, then reply as the step's prompt asks.
const agent = (reply: string) => `cat > /dev/null; ${reply}`;
const echoJson = (value: unknown) => agent(`echo '${JSON.stringify(value)}'`);

const env = {
  ...process.env,
  PATH: `${join(SANDBOX, "bin")}:${process.env.PATH}`,
  FAKE,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t"
};

function cli(command: string, ...args: string[]) {
  const file = join(REPO, "cli", command);
  const result = spawnSync(file.endsWith(".sh") ? file : "bun", file.endsWith(".sh") ? args : [file, ...args], {
    cwd: REPO,
    env,
    encoding: "utf8"
  });
  if (result.status !== 0) throw new Error(`${command} exited ${result.status}:\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

const sfCalls = () => readFileSync(join(FAKE, "calls.log"), "utf8");

beforeAll(() => {
  rmSync(SANDBOX, { recursive: true, force: true });
  mkdirSync(join(SANDBOX, "bin"), { recursive: true });
  mkdirSync(FAKE);
  writeFileSync(join(SANDBOX, "bin/sf"), FAKE_SF);
  chmodSync(join(SANDBOX, "bin/sf"), 0o755);
  writeFileSync(join(FAKE, "pmd.json"), JSON.stringify({ violations: [violation] }));
  writeFileSync(join(FAKE, "sfge.json"), JSON.stringify({ violations: [] }));
  writeFileSync(join(FAKE, "tests.json"), JSON.stringify(TESTS));
  writeFileSync(join(FAKE, "test.log"), testLog("ns.AccountHealthRollupTest.headroomAt200Accounts") + testLog("ns.AccountHealthRollupTest.other"));

  for (const path of ["cli", "force-app", ".prettierrc", ".prettierignore", ".gitignore"]) {
    cpSync(join(REPO_ROOT, path), join(REPO, path), { recursive: true });
  }
  symlinkSync(join(REPO_ROOT, "node_modules"), join(REPO, "node_modules"));
  const defaults = JSON.parse(readFileSync(join(REPO_ROOT, "ascent.config.json"), "utf8"));
  const config = {
    ...defaults,
    steps: {
      plan: { model: "m", command: echoJson({ reason: "r", focus: ["PMD"], edits: ["e"] }) },
      implement: { model: "m", command: agent(`echo '// tweak' >> ${APP_CLASS}`) },
      learn: { model: "m", command: echoJson({ learning: "l" }) },
      retro: { model: "m", command: echoJson(RETRO) }
    },
    weights: { ...defaults.weights, "Graph Engine": 0 }
  };
  writeFileSync(join(REPO, "ascent.config.json"), JSON.stringify(config));
  for (const args of [["init", "-q"], ["add", "-A"], ["commit", "-q", "-m", "base"]]) {
    expect(spawnSync("git", args, { cwd: REPO, env }).status).toBe(0);
  }
});

describe("CLIs", () => {
  test("score-prepare collects every input", () => {
    cli("score-prepare.sh", "org", "target/tmp/score", "AccountHealthRollupTest");
    const out = join(REPO, "target/tmp/score");
    for (const file of ["deploy.json", "pmd.json", "sfge.json", "tests.json", "logs/test.log"]) {
      expect(existsSync(join(out, file))).toBe(true);
    }
  });

  test("score skips a dimension with weight 0", () => {
    const args = ["-a", "force-app/**/classes/*.cls", "-t", "force-app/**/classes/*Test.cls", "-r", "target/tmp/score", "--headroom-test", "AccountHealthRollupTest.headroomAt200Accounts"];
    const result = JSON.parse(cli("score.ts", ...args, "-w", '{"Graph Engine": 0}'));
    expect(result.gated).toBe(false);
    expect(result.dimensions.map((d: { name: string }) => d.name)).not.toContain("Graph Engine");
    expect(result.dimensions).toHaveLength(6);
  }, 30_000);

  test("map gathers, scores every group without deploying, and renders both pages", () => {
    rmSync(join(FAKE, "calls.log"), { force: true });
    cli("map.ts", "gather", "s", "force-app/**/classes/*.cls");
    const dir = join(REPO, "target/map/s");
    const map = JSON.parse(readFileSync(join(dir, "map.json"), "utf8"));
    expect(map.groups.map((g: { id: string }) => g.id)).toEqual(["account-health-rollup", "case-sla-escalation", "contact-email-normalizer"]);
    cli("map.ts", "check", "s");
    cli("map.ts", "render", "s");
    expect(() => cli("map.ts", "score", "s", "-o", "org")).toThrow("not approved");
    writeFileSync(join(dir, "map.json"), JSON.stringify({ ...map, approved: true }));
    const scores = JSON.parse(cli("map.ts", "score", "s", "-o", "org"));
    expect(Object.keys(scores)).toHaveLength(3);
    expect(scores["account-health-rollup"].skipped).toEqual(["Limit headroom"]);
    expect(scores["account-health-rollup"].dimensions["Code coverage"]).toBe(90);
    expect(existsSync(join(dir, "runs/account-health-rollup/logs/test.log"))).toBe(true);
    expect(sfCalls()).toContain("--detailed-coverage");
    expect(sfCalls()).not.toContain("deploy");
    expect(sfCalls().match(/apex run test/g)).toHaveLength(1);
    rmSync(join(FAKE, "calls.log"));
    cli("map.ts", "score", "s", "-o", "org");
    expect(existsSync(join(FAKE, "calls.log"))).toBe(false);
    cli("map.ts", "score", "s", "-o", "org", "--fresh");
    expect(sfCalls()).toContain("apex run test");
    cli("map.ts", "render", "s", "--scores");
    for (const page of ["before.html", "after.html"]) expect(existsSync(join(dir, page))).toBe(true);
  }, 60_000);

  test("ascent-init scores the baseline without running Graph Engine", () => {
    rmSync(join(FAKE, "calls.log"), { force: true });
    const result = JSON.parse(cli("ascent-init.ts", "t", "-o", "org"));
    expect(Object.keys(result.baseline)).not.toContain("Graph Engine");
    expect(sfCalls()).not.toContain("sfge");
    expect(existsSync(join(REPO, "target/worktrees/t/.git"))).toBe(true);
  }, 60_000);

  test("iterate runs plan, implement, score and learn", () => {
    const result = JSON.parse(cli("iterate.ts", "t"));
    expect(result.iteration).toBe(1);
    expect(result.outcome).toBe("discard");
    expect(result.learning).toBe("l");
  }, 60_000);

  test("confirm deploys and scores the start and best kept commits with every default weight", () => {
    const result = JSON.parse(cli("confirm.ts", "t"));
    expect(result.confirmed).toBe(true);
    expect(Object.keys(result.best.scores)).toContain("Code coverage");
    expect(existsSync(join(ASCENT, "confirm/baseline/deploy.json"))).toBe(true);
  }, 60_000);

  test("report writes the HTML report", () => {
    expect(cli("report.ts", "t").trim()).toBe(join(ASCENT, "report.html"));
    expect(readFileSync(join(ASCENT, "report.html"), "utf8")).toContain("<html");
  }, 30_000);

  test("retro writes a coded retrospective", () => {
    cli("retro.ts", "t");
    const retro = JSON.parse(readFileSync(join(ASCENT, "retro.json"), "utf8"));
    expect(retro.behaviourChanges[0].code).toBe("B1");
    expect(retro.testGaps[0].code).toBe("T1");
  }, 30_000);
});
