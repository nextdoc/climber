# CLIs

Each CLI is one file under `cli/`, run with Bun from the repo root. Ascent state lives in `target/ascents/<name>/`.

## ascent-init

`bun cli/ascent-init.ts <name> -o <org>` starts an ascent. It creates the branch `ascent/<name>` and a worktree at `target/worktrees/<name>`, formats and commits the baseline, then scores it. `--mode streamline` scores with Streamline scripts instead of a deploy and Apex test run (`doc/streamline.md`).

| Option | Default | Description |
|---|---|---|
| `<name>` | required | Ascent name, used for the branch and the worktree |
| `-o, --target-org <org>` | required | Org alias or username to deploy and test in |
| `-r, --repo <path>` | this repo | Git repo whose classes to climb. The worktree is created from it at `<repo>/target/worktrees/<name>` ([Streamline](streamline.md#another-repo)) |
| `--from <ref>` | `HEAD` | Commit the ascent starts from |
| `-c, --config <file>` | `ascent.config.json` | Ascent defaults to start from |

## iterate

`bun cli/iterate.ts <name>` runs one iteration: plan, implement, format, score, keep or discard, then learn. It prints a JSON summary, including `stop` and `stopReason` when the ascent has reached `maxDiscards` consecutive discards, or `plateauDiscards` (default 3) consecutive discards whose focus dimensions did not rise by more than their margins.

| Option | Default | Description |
|---|---|---|
| `<name>` | required | Ascent name |
| `--dry-run` | off | Run every step, then restore the worktree instead of committing |

## report

`bun cli/report.ts <name>` rewrites `target/ascents/<name>/report.html`. `ascent-init`, `iterate` and `retro` already call it.

| Option | Default | Description |
|---|---|---|
| `<name>` | required | Ascent name |

## confirm

`bun cli/confirm.ts <name>` deploys the ascent's start commit and its best kept commit to the target org, runs the sample and holdout tests, and scores both in deploy mode with the default weights. It writes `target/ascents/<name>/confirm.json` and exits 1 unless the best commit compiles and passes every test. Use it to confirm a streamline ascent before merging. It leaves the best kept code deployed.

| Option | Default | Meaning |
|---|---|---|
| `<name>` | required | Ascent name |
| `--no-baseline` | off | Score only the best kept commit |

## retro

`bun cli/retro.ts <name>` writes a first-pass retrospective of an ascent to `target/ascents/<name>/retro.json` and adds it to the report. It gives one agent step fixed inputs: the diff from baseline to the evolved code, any test or fixture files changed, every iteration's reason, decision and learning, the scores, the test classes and any requirement documents. The reply has a fixed shape: a summary plus lists of behaviour changes (B1…), code patterns (P1…), test gaps (T1…) and other findings (X1…). Each item is free text with evidence.

The fixed shape makes ascents comparable, for example by the number and severity of behaviour changes each one introduced. It is a first pass, not a verdict. Any agent can replace it, skip it, or review the retrospective and the code for anything it missed.

| Option | Default | Description |
|---|---|---|
| `<name>` | required | Ascent name |
| `-s, --spec <files...>` | none | Requirement documents the code should meet, for example `doc/account-health-rollup.md` |

## anchor

`bun cli/anchor.ts <command>` groups the [anchor](anchor.md#anchor) tools. Work in progress.

`bun cli/anchor.ts audit <name> [-s <spec>]` writes the audit's inputs to `target/ascents/<name>/anchor/audit/input/`: the application classes at the baseline and final commits, the test classes and fixtures, the diff, the iterations and the spec. It then runs the audit agent step from [cli/prompts/anchor-audit.md](../cli/prompts/anchor-audit.md), which writes `anchor/audit/findings.json`, and checks the result as `check-findings` does. `--no-agent` rewrites the inputs and checks the existing findings.

`bun cli/anchor.ts check-findings <findings> -i <input dir>` validates an audit's findings JSON: its shape, ids and links, verdicts, and `file:line` references into the audit's input folder. It prints `{"ok": true, ...}` with the number of findings per kind, or the errors, and exits 1 on errors. The audit agent runs it on its own output until it passes.

`bun cli/anchor.ts verify <name> [-f <findings>]` reproduces each behaviour change (B), by default from the findings `audit` wrote. It writes the baseline classes renamed with a `Baseline` suffix, the final classes and the fixtures to `target/ascents/<name>/anchor/verify/input/`, then runs the verify agent step from [cli/prompts/anchor-verify.md](../cli/prompts/anchor-verify.md), which writes one scenario class per finding. Streamline runs each scenario on the baseline and the final code, and the harness compares their outputs. The findings, each with a verify status of reproduced, not reproduced, skipped or error, go to `target/ascents/<name>/anchor/findings.json`. `--no-agent` reruns the existing scenarios. Scratch orgs only.

`bun cli/anchor.ts run-scenario <name> <ids...>` runs the given scenarios and prints both versions' outputs. The verify agent runs it on its own scenarios until they run.

`bun cli/anchor.ts review <name> [-f <findings>] [--open]` writes the review page `target/ascents/<name>/anchor/review.html` from the findings `verify` wrote. Each finding has decision buttons for its kind, kept in browser storage until the findings change, and a button copies the decisions as JSON to paste into the chat. `--open` opens the page in the default browser.

## score-prepare and score

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
