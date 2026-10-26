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

## Non-goals

- NG1: Improving your business logic. A generic tool can't know what your business logic should be.
- NG2: Guaranteeing that performance changes preserve your code's business behaviour. Your tests define the behaviour, and anything they don't cover can change.

## Installation

Prerequisites, with minimum versions where one matters and otherwise the version this repo is tested on:

| Tool | Version | Used for |
|---|---|---|
| [Bun](https://bun.sh) | 1.3 | Running the CLIs and tests |
| Node.js and npm | 22 | Installing the pinned dependencies |
| [Salesforce CLI](https://developer.salesforce.com/tools/salesforcecli) (`sf`) | 2+ | Deploying, testing and querying the org |
| Code Analyzer plugin | 5.0+ | PMD and Graph Engine scoring (`sf plugins install code-analyzer`). Version 4 used `sf scanner run`, which the scoring doesn't support |
| Java | 11 or later | Required by the PMD and Graph Engine engines |
| [jq](https://jqlang.org) | 1.8 | Parsing CLI output in `cli/score-prepare.sh` |
| [Claude Code](https://claude.com/claude-code) (`claude`) | 2.1 | The default agent steps in `ascent.config.json` |

A scratch org, and the Dev Hub to create it, is only needed if your project uses scratch orgs or to climb the included sample.

```sh
git clone <repo url> climb-your-apex
cd climb-your-apex
npm ci
sf org create scratch -f config/project-scratch-def.json -a climb-your-apex --target-dev-hub <dev hub alias>
bun test ./cli
```

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

`bun cli/ascent-init.ts <name> -o <org>` starts an ascent. It creates the branch `ascent/<name>` and a worktree at `target/worktrees/<name>`, formats and commits the baseline, then scores it.

| Option | Default | Description |
|---|---|---|
| `<name>` | required | Ascent name, used for the branch and the worktree |
| `-o, --target-org <org>` | required | Org alias or username to deploy and test in |
| `--from <ref>` | `HEAD` | Commit the ascent starts from |
| `-c, --config <file>` | `ascent.config.json` | Ascent defaults to start from |

### iterate

`bun cli/iterate.ts <name>` runs one iteration: plan, implement, format, score, keep or discard, then learn. It prints a JSON summary, including `stop` when the ascent has reached its maximum consecutive discards.

| Option | Default | Description |
|---|---|---|
| `<name>` | required | Ascent name |
| `--dry-run` | off | Run every step, then restore the worktree instead of committing |

### report

`bun cli/report.ts <name>` rewrites `target/ascents/<name>/report.html`. `ascent-init`, `iterate` and `retro` already call it.

| Option | Default | Description |
|---|---|---|
| `<name>` | required | Ascent name |

### retro

`bun cli/retro.ts <name>` writes a first-pass retrospective of an ascent to `target/ascents/<name>/retro.json` and adds it to the report. It gives one agent step fixed inputs: the diff from baseline to the evolved code, any test or fixture files changed, every iteration's reason, decision and learning, the scores, the test classes and any requirement documents. The reply has a fixed shape: a summary plus lists of behaviour changes (B1…), code patterns (P1…), test gaps (T1…) and other findings (X1…). Each item is free text with evidence.

The fixed shape makes ascents comparable, for example by the number and severity of behaviour changes each one introduced. It is a first pass, not a verdict. Any agent can replace it, skip it, or review the retrospective and the code for anything it missed.

| Option | Default | Description |
|---|---|---|
| `<name>` | required | Ascent name |
| `-s, --spec <files...>` | none | Requirement documents the code should meet, for example `doc/account-health-rollup.md` |

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
