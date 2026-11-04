# Is it safe?

Each way of using climber, from reading the sample report to an ascent in a sandbox, and what it changes. The levels run in the order most people adopt the tool. Every level up to L5 is read only for your org's code.

## Levels

| Level | What you run | Org | Changes in the org | Changes in your repo | Undo |
|---|---|---|---|---|---|
| L0 | Read the docs and the [sample report](https://nextdoc.github.io/climber/account-health-deploy.html) | none | None | None | Nothing to undo |
| L1 | Quick start, mapping: [map](mapping.md) the sample classes with `config/map.sample.json`, then `map score` | new scratch org for the samples | Needs the unchanged sample classes deployed once. `map score` runs their tests and adds a debug level, a trace flag and debug logs. Never deploys a change | None. The map is in climber's `target/map/` | Delete the scratch org |
| L2 | [Quick start](../README.md#quick-start), ascent: an ascent on the sample classes, deploy mode | new scratch org for the samples | Deploys the sample classes, then each iteration's candidate code. Runs the sample tests. Adds a debug level, a trace flag and debug logs | None. The ascent's branch and worktree are in climber's repo | Delete the scratch org |
| L3 | An ascent on the sample classes, Streamline mode | new scratch org for the samples | Nothing deployed. Candidate code runs as anonymous Apex and its DML is rolled back. `confirm` deploys at the end | None | Delete the scratch org |
| L4 | [Map](mapping.md) your code: `map gather`, `check` and `render` | none | None | None. Climber reads your repo and writes only to its own `target/map/` | Nothing to undo |
| L5 | `map score` against your code | your scratch org | Runs your test classes, whose data Apex rolls back. Adds a debug level, a trace flag and debug logs. Never deploys | Creates `target/tmp/code-analyzer/logs` | Delete the scratch org |
| L6 | An ascent on your code, Streamline mode | your scratch org | Nothing deployed. Candidate code runs as anonymous Apex and its DML is rolled back. Callouts and platform events published immediately are not rolled back, and rollback of sent email and queued async jobs is untested. `confirm` deploys the start and best commits and leaves the best deployed | Adds the branch `ascent/<name>` and a worktree under `target/worktrees/<name>` | Delete the scratch org. Delete the branch and worktree |
| L7 | An ascent on your code, deploy mode | your scratch org | Deploys every package directory in `sfdx-project.json` for the baseline and each candidate, and runs the tests. The org keeps whatever was deployed last, which can be a discarded candidate | Adds the branch and worktree, as in L6 | Delete the scratch org. Delete the branch and worktree |
| L8 | An ascent on your code, deploy mode | sandbox | As L7, in an org other people use: candidate code overwrites the classes they run, and tests run in their org | Adds the branch and worktree, as in L6 | Redeploy from your main branch, which the ascent's own branch leaves unchanged |
| — | Anything | production | Never point climber at production | | |

L5 against a sandbox also works. It changes the same things as in a scratch org, and the debug logs count against the sandbox's log storage.

## What the tools enforce

- `ascent-init` refuses Streamline mode and planner probes unless the org is a scratch org.
- Deploy mode, `confirm` and `map score` do not check the org type. Choosing a scratch org or a sandbox, and never production, is up to you.
- Planner probes name their own org. The prompt names the ascent's org, but Streamline can reach any org the sf CLI is authorised for. See [Org safety](streamline.md#org-safety).

## Branches and worktrees

An ascent never edits the branch you have checked out.

- `ascent-init` creates the branch `ascent/<name>` and a worktree on it, under `target/worktrees/<name>`. Agents edit only the worktree.
- A kept iteration is a commit on that branch. A discarded one is reset, so the branch only ever holds kept changes.
- Nothing reaches your main branch until you merge it. Merge after the retrospective, and in Streamline mode after `confirm`, taking only the changes you approve.

## Code sent to the model

The agent steps run your agent CLI, `claude` by default, so the classes being climbed, their tests and any spec files go to its model provider. `map gather`, `check`, `render` and `score` call no agent. The mapping steps where an agent refines or tags groups send it the classes it reads.
