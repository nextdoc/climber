# Correctness

This tool cannot assume that the code it climbs or the tests that guard it are fully correct. Real code carries bugs and unwritten decisions, and real tests cover only some of its behaviour. So one of the tool's features is improving correctness itself: an ascent exposes where the code, the tests or the spec are incomplete or wrong, and that evidence drives fixes to them.

Scores measure code quality and resource use, not correctness. Correctness enters an ascent only through the tests, as a pass or fail gate. Any behaviour the tests do not pin is free for the climb to change, and it will change it when that raises a score.

Three sources describe what the code should do, and in real codebases any of them can be missing, incomplete or wrong:

- **Spec.** A written description of the intended behaviour. Often absent. Here it is `doc/account-health-rollup.md`.
- **Original code.** The code before the climb. It may contain bugs or decisions nobody wrote down.
- **Tests.** They pin only the behaviours someone thought to check.

Climbing exposes these weaknesses. A kept candidate that changes behaviour shows a gap in the tests, and comparing it with the spec shows whether the original code or the candidate is wrong. If the original code or the tests are wrong, the climb optimises towards a wrong target.

## Anchor

An anchor uses a scout ascent's drift to fix the tests, the code and the spec. It is optional. A user can start climbing without it, and any completed ascent can serve as the scout later. The inventory below was produced by hand this way, and an anchor automates it. The step names are defined in the [glossary](glossary.md#anchor).

**Maturity: early.** Audit, verify and review are implemented and have been run end to end on one sample ascent. Apply and Track are not built yet. Audit findings vary from run to run, particularly defects, spec gaps and test gaps, and verify skips findings that depend on users, sharing or org metadata. The prompts, finding kinds and decision options will probably change as users give feedback.

```mermaid
flowchart TD
  S[Scout ascent] --> SO[/"baseline and final code, kept diffs, tests, spec"/]
  SO --> A[Audit agent]
  A --> AF[/"findings.json from the audit"/]
  AF --> V[Verify agent]
  V --> SC[/"anchor/verify/scenarios.apex, checked with run-scenario"/]
  AF --> H[Harness: a Streamline rollback per version, baseline vs final]
  SC --> H
  H --> VF[/"anchor/findings.json: the audit's findings + verify status"/]
  VF --> R[Review page]
  R --> DJ[/"decisions.json"/]
  DJ --> D{Decision per finding}
  D -->|preserve: test pins baseline behaviour| P[Apply agent]
  D -->|fix: test pins spec behaviour, baseline is a bug| P
  D -->|clarify: spec edit| P
  D -->|reject| X[Dropped]
  P --> PO[/"tests and spec edits on main"/]
  PO --> N[Next ascent re-measures baseline]
  N --> T[Track: do closed gaps recur?]
  classDef file fill:#f4f4f4,stroke:#888,stroke-dasharray:4 3
  class SO,AF,SC,VF,DJ,PO file
```

- **Audit.** The prompt is fixed and generic, so it works on any project. It is in [anchor-audit.md](../cli/prompts/anchor-audit.md). With a spec, each behaviour change is classified against it. With no spec, nothing says whether the baseline or the final code is right, so every behaviour change is raised as a spec gap for the user to answer.
- **Findings.** `findings.json` is validated with Zod, like the retro reply. Each finding has a code in one of the categories used below: B (behaviour change), D (defect against the spec), U (spec gap) and T (test gap). It also carries the evidence, the iterations involved, a proposed test with its seed data and expected result, and, after verify, a `verify` block added by the harness, with a status of reproduced, not reproduced, skipped or error and both outputs.
- **Verify.** A baseline oracle with a challenger. For each behaviour change, an agent writes seed data aimed at it, such as an Event, a contact task or another closed status. Two Streamline rollbacks, one per version, run a renamed copy of the baseline class and the final class on the same seed data, each with its own governor limits, and compares ratings, created tasks and field writes. It runs once after the ascent, so it adds no time to the ascent. The harness writes a copy of the audit's findings to `anchor/findings.json`, with a `verify` block on each behaviour change. A finding that does not reproduce stays in the copy with the status not reproduced, so the user can see what the audit claimed.
- **Review page.** A pre-built HTML template, like the ascent report, renders `findings.json` grouped by category, with evidence and verify status beside each finding.
- **Decide.** The user decides per finding on the review page, from the options its kind allows: B preserve, fix, clarify or reject; D fix or reject; U clarify, with the answer in a note, or reject; T add-test or reject. The page keeps the decisions in browser storage for one review at a time, keyed by a hash of the findings, so new findings start blank. A button copies them as JSON to paste into the chat, and the agent writes `decisions.json`. A local server that writes the file directly is deferred.

### Roadmap

**Behaviour guard.** An ascent after an anchor guards behaviour on every candidate, not only through the tests. Behaviour changes on purpose only in an anchor, so the guard is chosen at `ascent-init` and fixed for the ascent, like the mode: a `behaviour` field in `ascent.config.json`, overridable with `--behaviour`.

- **`strict`.** `iterate` gates each candidate with the baseline oracle, using the seed data verified in the last anchor. Any difference in output discards the candidate.
- **`judged`.** A candidate that fails the oracle goes to a spec-judge agent step, which keeps it only when the difference improves adherence to the spec. The judge's reasoning is recorded in the history for review after the ascent. `ascent-init` refuses `judged` without a spec.

## Inventory for the sample

The original `AccountHealthRollup` was written as a naive baseline (commit `a06a7cb`), so its scoring weaknesses are deliberate. The correctness defects and gaps below were found by reviewing the ascents, and not all of them were planted. Line numbers refer to the original class on `main`.

### Scoring weaknesses (deliberate)

| Code | Where | What |
|---|---|---|
| S1 | `AccountHealthRollup.cls:30` | Filter values are concatenated into dynamic SOQL (injection). |
| S2 | `:1` | No sharing declaration, no CRUD or FLS checks, no user mode. |
| S3 | `:84`, `:101` | Nested loops scan every opportunity and task for every account. |
| S4 | `:157`, `:167` | A query and an insert per account that needs follow-up. |
| S5 | `:25`, `:62`, `:72` | Unused fields in every SELECT. |
| S6 | `:34`, `:38`, `:111`, `:168` | `System.debug` calls. |
| S7 | `:55` | One long method with high cyclomatic and cognitive complexity. |

### Defects against the spec

| Code | Where | What | Spec |
|---|---|---|---|
| D1 | `:93` | Open pipeline excludes only the stages named 'Closed Won' and 'Closed Lost', so a custom closed stage counts as pipeline. | "open opportunities" (`:21`) |
| D2 | `:157` | An open follow-up is any task whose status is not 'Completed', so a task closed with another status still blocks a new follow-up. | "an open task with the same subject" (`:47`) |
| D3 | `:157`, `:167` | One query and one insert per follow-up fail past about 100 follow-ups or 150 inserts in one run. | "up to every account in the org" (`:60`) |

### Spec gaps

| Code | Question the spec leaves open |
|---|---|
| U1 | Hot rule grouping: "(won or pipeline) and recent activity", or "won, or (pipeline and recent activity)"? The code uses the first. |
| U2 | Is "same subject" case-sensitive? SOQL `=` is not. |
| U3 | Does a task closed with a status other than 'Completed' count as completed activity? |
| U4 | Should the run rate every account, or only those the running user can see and edit? |
| U5 | Does "last 12 months" mean 365 days, and does a won opportunity with a future close date count? |

### Test gaps

| Code | Missing scenario | Ascent drift it would have caught |
|---|---|---|
| T1 | A completed Event on the account | `LastActivityDate`, `ActivityHistories` (streamline-1, trial-3, trial-4, streamline-2 #18) |
| T2 | A completed task on one of the account's contacts | `Task.AccountId`, `LastActivityDate` (streamline-2 #13, streamline-1, trial-4) |
| T3 | A task closed with a status other than 'Completed' | Same as T1, and D2 |
| T4 | An open Event or an open task with a similar subject | `OpenActivities` and `LIKE 'Re-engage %'` dedup (trial-3, trial-4, deploy-probes-1) |
| T5 | An opportunity in a custom closed stage | D1, and trial-4's `IsClosed = false` fix |
| T6 | Rating boundaries: exactly 100,000 won, 250,000 pipeline, 30 and 90 days | None observed yet |
| T7 | A run by a user without View All Data | `ActivityHistories`, `OpenActivities` restriction (trial-3, deploy-probes-1) |
| T8 | More than 200 accounts, and more than 100 follow-ups | D3, and dropping the 200-record chunks (all ascents) |
| T9 | An account whose Rating does not change | Skipping the update when Rating is unchanged (streamline-1) |
