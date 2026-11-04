# Glossary

| Term | Meaning |
|---|---|
| Climber | The short name for this toolset: the CLIs, prompts and scoring that run ascents. Also used as an adjective, as in a climber ascent or climber config. |
| Ascent | The loop of iterations from a baseline: each one tries a candidate, scores it, and keeps or discards it. It ends at the summit, after `maxDiscards` consecutive discards, after `plateauDiscards` consecutive discards whose focus did not rise by more than its margin, or when stopped. |
| Summit | Every dimension within its margin of 100. No candidate can be kept there, so the ascent stops. |
| Ascent branch and worktree | `ascent-init` creates the branch `ascent/<name>` in the climbed repo and a git worktree on it under `target/worktrees/<name>`. Agents edit only the worktree. A kept iteration is a commit on the branch and a discarded one is reset, so the branch holds only kept changes until the user merges it. |
| Iteration | One pass of an ascent: plan a candidate, apply it, run, score, then keep or discard it. One CLI invocation runs one iteration. |
| Agent step | One agent call, with its own model and command under `steps` in the ascent config. An iteration runs plan, implement and learn in order. After the ascent, `retro` runs the retro step, and the anchor runs the audit and verify steps. |
| Plan | The agent step that reads the scores, findings and history, then states the reason, focus and intended edits. It does not edit code. |
| Probe | A small anonymous Apex script the plan step runs with Streamline's `runAndRollback` to answer a question before choosing a candidate, such as whether an approach compiles, what a query returns, or how many limits it uses. Enabled per ascent by `ascent-init --planner-streamline` (up to 5 per plan) and independent of the mode. An ascent with them enabled is said to use planner probes. |
| Implement | The agent step that makes the planned edits to application files. |
| Learn | The agent step that runs after the keep or discard decision. It reads the plan, the diff and the score changes, then writes one learning to the history. |
| Learning | The one-line lesson the learn step records for an iteration. Later plan steps read the learnings, and the retrospective draws on them. |
| Candidate | The bundle of code edits an iteration tries, aimed at one weakness. |
| Run | One collection of raw inputs (deploy, analyzers, tests, logs) into a run folder, and the scores computed from it. A map has one run for all its groups, sliced into one folder per group. |
| Mode | How runs collect their inputs from the org: deploy or Streamline. Chosen with `ascent-init --mode` and fixed for the whole ascent. Streamline mode gives the dimensions it cannot measure weight 0 and reads the `streamline` block of the ascent config. |
| Deploy mode | Deploys the application and test classes, then runs the Apex test classes with the sf CLI. The only mode that scores code coverage. |
| Streamline | The MCP server that runs anonymous Apex in an org and rolls back its DML. Climber uses it for Streamline mode, probes and the anchor's verify step. |
| Streamline mode | Composes anonymous Apex scripts from the class files and runs them with Streamline, which rolls back the org afterwards. Nothing is deployed. Faster than deploy mode, but cannot score coverage or run static entry points. Only allowed against a scratch org. |
| Suite | What Streamline mode composes for one climbed class: its classes, its scenarios file and its variants. Defined in the `streamline` block of the ascent config. |
| Scenario | A test method rewritten to run in anonymous Apex, in a suite's scenarios file. Each scenario reports its own result. |
| Variant | One composed Streamline script with one entry point, such as `correctness` or `headroom`. Each runs in its own transaction with its own governor limits. |
| Confirm | `confirm` deploys the ascent's start commit and best kept commit, runs every test and scores both in deploy mode. It checks a Streamline ascent before merging and leaves the best kept code deployed. |
| Baseline | The scores of the code before the climb starts, or after the classes or tests being climbed change. |
| Dimension | One measured aspect of the code, such as PMD or test run time. Each scores 0 to 100. |
| Score | A dimension's value from 0 to 100. 100 is perfect. |
| Penalty | The total a dimension's formula turns into a score, such as severity-weighted violations or seconds. |
| Severity weight | The penalty points one violation costs, by severity. |
| Half-score penalty | The penalty that scores exactly 50. Sets how strict a dimension is. Overridden per dimension by `halfScores` in the ascent config. |
| Limit headroom | How far one 200-record batch stays below its tightest governor limit. |
| Headroom test | The test whose limit use scores limit headroom, one per climbed class. Named by `headroomTest` in the ascent config or the map. |
| Resource efficiency | How few governor-limit resources the tests use for the same work. |
| Overall score | The weighted mean of all dimension scores. The headline number, not the keep rule. |
| Gate | A check that hard-fails the iteration. A gated run scores 0 overall and is never kept. The gates are `compile`, `extract` in Streamline mode when a class can't be adapted to anonymous Apex, and `tests` when scoring without a deploy and the tests did not run. |
| Evaluation cascade | The order of evaluation: compile, then static analysis, then tests, then performance. A gate failure stops the cascade. |
| Focus | The dimensions a candidate aims to raise, stated by the planner before the run. |
| Deterministic dimension | A dimension that scores unchanged code the same on every run, such as PMD. A nondeterministic dimension varies between runs of unchanged code, such as test run time on a shared Salesforce org. Every dimension is classified as one or the other. |
| Margin | The smallest change in a dimension's score that counts as a real rise or fall. For a nondeterministic dimension it is the noise band, measured from the spread of repeated unchanged baseline runs. For a deterministic dimension any change is real, so the margin is the smallest change worth keeping, set from known changes or 0. |
| Keep / discard | The outcome of an iteration. Keep when the focus dimensions rise and nothing else falls, each by more than its margin, and no dimension drops below half its best score. A candidate that only misses its focus is still kept when the overall score rises by more than the largest weighted margin of any one dimension. |
| Sample tests | Test classes the agent can read but not edit. Listed under `testClasses.sample` in the ascent config. |
| Holdout | Test classes the agent can neither see nor edit. Listed under `testClasses.holdout` in the ascent config. They run and score with the sample tests. |
| Application files | The Apex classes under improvement. Excludes test classes and test fixtures. |
| Test fixtures | Classes that build test data for the tests, such as `Fixtures`. The agent can read them but not edit them, and they are not scored as application files. |
| Sample classes | The three classes included with climber, `AccountHealthRollup`, `CaseSlaEscalation` and `ContactEmailNormalizer`, for trying climbing in a scratch org before climbing your own code. Not to be confused with sample tests. |
| Retrospective | What `retro` writes after an ascent: a summary, then coded behaviour changes (B1…), code patterns (P1…), test gaps (T1…) and other findings (X1…). The user reviews it before merging. |
| Side-effect level | One of the levels L0 to L8 in [Is it safe?](is-it-safe.md), from reading the docs to an ascent in a sandbox, each with what it changes in the org and the repo. |

## Map

A treemap of an org's Apex code, used to choose what to climb. See [mapping.md](mapping.md).

| Term | Meaning |
|---|---|
| Map | The groups of a codebase's classes, kept in `target/map/<name>/map.json`, and the treemap pages rendered from it: `before.html` sized by lines, `after.html` also coloured by score. |
| Group | One rectangle of the map: app classes with their tests and fixtures, with an `id` that never changes so its score stays attached. |
| Unassigned | Classes the map holds in no group yet, such as tests and fixtures that several groups use. |
| Approved map | A map the user has reviewed and marked `"approved": true`. It has no unassigned classes. `map score` refuses any other. |
| Testing group | The group of shared test utilities. Scored on static analysis only and not climbed. |
| Tag | A group's value for a facet, such as `version: v3` or `area: rendering`. Each facet is one way to categorise the groups, and the page filters by tag. |

## Anchor

Optional steps that turn one ascent's behaviour drift into fixed tests, code and spec, in order. An ascent runs the same with or without them. See [anchor.md](anchor.md#anchor).

1. **Scout ascent.** Any completed ascent whose drift is used as the input to the anchor. Nothing marks an ascent as a scout in advance, so a first ascent run without an anchor can become a scout later.
2. **Audit.** An agent step with a pre-built prompt compares the baseline code, the final code, the kept diffs, the tests and the spec, if there is one. It records findings in a Zod-validated JSON file.
3. **Verify.** For each behaviour change, an agent writes seed data, and the harness runs the baseline and final classes on it in separate Streamline rollbacks and compares their outputs. Each finding gets a verify status of reproduced, not reproduced, skipped or error.
4. **Decide.** The user reviews the findings on an HTML page and gives each one a decision from the options its kind allows: preserve, fix, clarify, add-test or reject.
5. **Apply.** An agent writes the tests and spec edits the decisions call for. The next ascent measures its baseline with them.
6. **Track.** Later ascents check whether the closed gaps stay closed.
