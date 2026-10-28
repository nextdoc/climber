# Climb Your Apex

Agents improve Salesforce Apex code by hill climbing. Each iteration plans one change, implements it, and scores it on weighted dimensions that you control. It keeps the change only if the scores rise without anything regressing. The out-of-the-box dimensions:

- PMD: static analysis violations
- Graph Engine: data flow and path analysis violations
- Tests passing
- Code coverage
- Test run time
- Limit headroom: governor limit use for one batch of 200 records
- Resource efficiency: governor limit use across the other tests

The project comes with a sample class, `AccountHealthRollup`, and its test, `AccountHealthRollupTest`. Climb them with your agent in a separate scratch org to evaluate hill climbing on its own merits, before pointing it at your code.

An Apex-only Salesforce DX project. There are no Lightning Web Components, Aura components, or other JavaScript code.

## Goals

- G1: Improve your code's performance across all of the weighted scoring dimensions.
- G2: At the end of an ascent, give a retrospective of the features and gaps in your business domain logic. It draws on the changes and optimisations made and on what the agent steps observed, in particular the learnings recorded throughout the ascent.
- G3: Improve correctness. The tool doesn't assume your code or tests are fully correct. An ascent exposes behaviour your tests don't pin and places where the code, tests or spec disagree, so you can fix them. See [doc/anchor.md](doc/anchor.md).

## Non-goals

- NG1: Guaranteeing that performance changes preserve your code's business behaviour. Your tests define the behaviour, and anything they don't cover can change.

## Installation

Prerequisites, with minimum versions where one matters and otherwise the version this repo is tested on:

| Tool | Version | Used for |
|---|---|---|
| [Bun](https://bun.sh) | 1.3 | Running the CLIs and tests |
| Node.js and npm | 22 | Installing the pinned dependencies |
| [Salesforce CLI](https://developer.salesforce.com/tools/salesforcecli) (`sf`) | 2+ | Deploying, testing and querying the org |
| Code Analyzer plugin | 5.0+ | PMD and Graph Engine scoring (`sf plugins install code-analyzer`). Version 4 used `sf scanner run`, which the scoring doesn't support |
| Java | 11 or later | Required by the PMD and Graph Engine engines |
| [Claude Code](https://claude.com/claude-code) (`claude`) | 2.1 | The default agent steps in `ascent.config.json` |

A scratch org, and the Dev Hub to create it, is only needed if your project uses scratch orgs or to climb the included sample.

```sh
git clone <repo url> climb-your-apex
cd climb-your-apex
npm ci
sf org create scratch -f config/project-scratch-def.json -a climb-your-apex --target-dev-hub <dev hub alias>
bun test ./cli
```

## Process

Instructions for an agent using this project. The terms are defined in the [glossary](doc/glossary.md).

1. Install the prerequisites above and confirm `bun test ./cli` passes.
2. Start an ascent with `bun cli/ascent-init.ts <name> -o <org>`. This scores the baseline.
3. Run `bun cli/iterate.ts <name>` repeatedly until its summary reports `stop`.
4. Write the retrospective with `bun cli/retro.ts <name>`, passing `-s <spec files>` when the project has a spec. In Streamline mode, run `bun cli/confirm.ts <name>` too.
5. Show the user the report at `target/ascents/<name>/report.html`, then ask which path to take. Anchoring is optional.
   - **Adopt.** Review the retrospective, merge the best kept commit, and adopt the learnings and proposed tests the user approves.
   - **Anchor.** Treat the first ascent as the scout ascent and run the [anchor](doc/anchor.md#anchor) steps to fix the tests, code and spec. Then start a new ascent from the improved baseline.

## Dependencies

Node is used only for formatting. The dev dependencies are kept to that purpose:

- `prettier` - code formatter.
- `prettier-plugin-apex` - formats Apex classes (`.cls`) and triggers (`.trigger`).
- `@prettier/plugin-xml` - formats Salesforce metadata XML.

The ESLint, Jest, and LWC tooling from the default Salesforce DX template was removed because the project has no JavaScript to lint or test.

## Pinned versions

Dependency versions are pinned to reduce supply chain risk. A version range would let a newly published, possibly compromised release install automatically.

- `package.json` lists exact versions, and `.npmrc` sets `save-exact=true` so new dependencies are also saved without a range.
- `package-lock.json` pins every transitive dependency with an integrity hash. Commit it.
- Install with `npm ci`, which installs exactly what the lockfile specifies and fails if it is out of sync with `package.json`.
- To upgrade, change a version deliberately, review the new release, then run `npm install` and commit the updated lockfile.

## Commands

- `npm ci` - install the pinned dependencies.
- `npm run prettier` - format all files.
- `npm run prettier:verify` - check formatting without writing changes.

## Documentation

| Document | Covers |
|---|---|
| [Glossary](doc/glossary.md) | The terms used across the tools and docs, such as ascent, iteration, dimension, margin and mode. |
| [Scoring](doc/scoring.md) | Each dimension's source, formula and half-score penalty, the overall score, and how inputs are collected. |
| [Streamline](doc/streamline.md) | The two uses of Streamline: planner probes, and Streamline mode as a faster alternative to deploy mode. Draft. |
| [Caveats](doc/caveats.md) | Known limits on what the scores mean. |
| [Account Health Rollup](doc/account-health-rollup.md) | The requirements for the sample class the ascents climb. |
| [Anchor](doc/anchor.md) | The optional steps that fix tests, code and spec from a scout ascent's drift, and the sample's correctness inventory. |
| [References](doc/references.md) | Public research on agent loops and prompt optimisation that the project draws on. |

## Files overview

Each ascent creates two directories under `target/`, which git ignores. The worktree holds the code being improved, and the ascent directory records what happened.

```text
target/
├── worktrees/
│   └── <name>/                   git worktree on branch ascent/<name>: agents edit, deploy and test here
└── ascents/
    └── <name>/
        ├── ascent.json           this ascent's config, copied from ascent.config.json at init
        ├── history.jsonl         one entry per iteration: plan, scores, outcome, decision, learning, cost
        ├── report.html           the HTML report
        ├── retro.json            the retrospective, with coded items
        ├── retro/
        │   ├── prompt.md         the retro step's prompt
        │   └── agent.txt         the retro step's raw output
        ├── patches/
        │   └── <n>.patch         iteration n's candidate diff
        └── runs/
            └── <n>/              iteration n (0 is the baseline)
                ├── deploy.json        deploy result, the compile gate
                ├── pmd.json           PMD violations
                ├── sfge.json          Graph Engine violations
                ├── tests.json         test results and coverage
                ├── logs/              test debug logs, read for governor limit use
                ├── prepare.log        output of cli/score-prepare.sh
                ├── <step>-prompt.md   the plan, implement and learn prompts
                ├── <step>.txt         each step's raw output
                ├── error.txt          stack trace when the iteration errored
                └── entry.json         the full history entry when it failed validation
```

A dimension with weight 0 skips its tool, so its file is absent.

## CLIs

Each CLI is one file under `cli/`, run with Bun from the repo root. Ascent state lives in `target/ascents/<name>/`.

### ascent-init

`bun cli/ascent-init.ts <name> -o <org>` starts an ascent. It creates the branch `ascent/<name>` and a worktree at `target/worktrees/<name>`, formats and commits the baseline, then scores it. `--mode streamline` scores with Streamline scripts instead of a deploy and Apex test run (`doc/streamline.md`).

| Option | Default | Description |
|---|---|---|
| `<name>` | required | Ascent name, used for the branch and the worktree |
| `-o, --target-org <org>` | required | Org alias or username to deploy and test in |
| `--from <ref>` | `HEAD` | Commit the ascent starts from |
| `-c, --config <file>` | `ascent.config.json` | Ascent defaults to start from |

### iterate

`bun cli/iterate.ts <name>` runs one iteration: plan, implement, format, score, keep or discard, then learn. It prints a JSON summary, including `stop` and `stopReason` when the ascent has reached `maxDiscards` consecutive discards, or `plateauDiscards` (default 3) consecutive discards whose focus dimensions did not rise by more than their margins.

| Option | Default | Description |
|---|---|---|
| `<name>` | required | Ascent name |
| `--dry-run` | off | Run every step, then restore the worktree instead of committing |

### report

`bun cli/report.ts <name>` rewrites `target/ascents/<name>/report.html`. `ascent-init`, `iterate` and `retro` already call it.

| Option | Default | Description |
|---|---|---|
| `<name>` | required | Ascent name |

### confirm

`bun cli/confirm.ts <name>` deploys the ascent's start commit and its best kept commit to the target org, runs the sample and holdout tests, and scores both in deploy mode with the default weights. It writes `target/ascents/<name>/confirm.json` and exits 1 unless the best commit compiles and passes every test. Use it to confirm a streamline ascent before merging. It leaves the best kept code deployed.

| Option | Default | Meaning |
|---|---|---|
| `<name>` | required | Ascent name |
| `--no-baseline` | off | Score only the best kept commit |

### retro

`bun cli/retro.ts <name>` writes a first-pass retrospective of an ascent to `target/ascents/<name>/retro.json` and adds it to the report. It gives one agent step fixed inputs: the diff from baseline to the evolved code, any test or fixture files changed, every iteration's reason, decision and learning, the scores, the test classes and any requirement documents. The reply has a fixed shape: a summary plus lists of behaviour changes (B1…), code patterns (P1…), test gaps (T1…) and other findings (X1…). Each item is free text with evidence.

The fixed shape makes ascents comparable, for example by the number and severity of behaviour changes each one introduced. It is a first pass, not a verdict. Any agent can replace it, skip it, or review the retrospective and the code for anything it missed.

| Option | Default | Description |
|---|---|---|
| `<name>` | required | Ascent name |
| `-s, --spec <files...>` | none | Requirement documents the code should meet, for example `doc/account-health-rollup.md` |

### anchor

`bun cli/anchor.ts <command>` groups the [anchor](doc/anchor.md#anchor) tools. Work in progress.

`bun cli/anchor.ts audit <name> [-s <spec>]` writes the audit's inputs to `target/ascents/<name>/anchor/audit/input/`: the application classes at the baseline and final commits, the test classes and fixtures, the diff, the iterations and the spec. It then runs the audit agent step from [cli/prompts/anchor-audit.md](cli/prompts/anchor-audit.md), which writes `anchor/audit/findings.json`, and checks the result as `check-findings` does. `--no-agent` rewrites the inputs and checks the existing findings.

`bun cli/anchor.ts check-findings <findings> -i <input dir>` validates an audit's findings JSON: its shape, ids and links, verdicts, and `file:line` references into the audit's input folder. It prints `{"ok": true, ...}` with the number of findings per kind, or the errors, and exits 1 on errors. The audit agent runs it on its own output until it passes.

`bun cli/anchor.ts verify <name> [-f <findings>]` reproduces each behaviour change (B), by default from the findings `audit` wrote. It writes the baseline classes renamed with a `Baseline` suffix, the final classes and the fixtures to `target/ascents/<name>/anchor/verify/input/`, then runs the verify agent step from [cli/prompts/anchor-verify.md](cli/prompts/anchor-verify.md), which writes one scenario class per finding. Streamline runs each scenario on the baseline and the final code, and the harness compares their outputs. The findings, each with a verify status of reproduced, not reproduced, skipped or error, go to `target/ascents/<name>/anchor/findings.json`. `--no-agent` reruns the existing scenarios. Scratch orgs only.

`bun cli/anchor.ts run-scenario <name> <ids...>` runs the given scenarios and prints both versions' outputs. The verify agent runs it on its own scenarios until they run.

`bun cli/anchor.ts review <name> [-f <findings>] [--open]` writes the review page `target/ascents/<name>/anchor/review.html` from the findings `verify` wrote. Each finding has decision buttons for its kind, kept in browser storage until the findings change, and a button copies the decisions as JSON to paste into the chat. `--open` opens the page in the default browser.

### score-prepare and score

`cli/score-prepare.sh <org> <run folder> <test classes>` deploys `force-app`, runs PMD, Graph Engine and the tests, and saves the raw output and debug logs to the run folder. `bun cli/score.ts` scores that folder as defined in `doc/scoring.md`. `npm run score:prepare` and `npm run score` run them on this repo.

| Argument (score-prepare) | Description |
|---|---|
| `<org>` | Org alias or username |
| `<run folder>` | Folder to write the raw output to, emptied first |
| `<test classes>` | Comma-separated test classes to run |

| Option (score) | Default | Description |
|---|---|---|
| `-a, --app <globs...>` | required | Application Apex file globs |
| `-t, --test <globs...>` | required | Test Apex file globs, removed from the application set |
| `-r, --run <dir>` | `target/tmp/score` | Run folder |
| `--root <dir>` | `.` | Folder the globs and analyzer paths are relative to |
