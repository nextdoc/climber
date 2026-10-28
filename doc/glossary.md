# Glossary

| Term | Meaning |
|---|---|
| Ascent | The loop of iterations from a baseline: each one tries a candidate, scores it, and keeps or discards it. It ends after K consecutive discards, after a plateau of discards whose focus did not rise by more than its margin, or when stopped. |
| Iteration | One pass of an ascent: plan a candidate, apply it, run, score, then keep or discard it. One CLI invocation runs one iteration. |
| Agent step | One agent call within an iteration. Each has its own model and command under `steps` in the ascent config. The steps run in order: plan, implement, learn. |
| Plan | The agent step that reads the scores, findings and history, then states the reason, focus and intended edits. It does not edit code. |
| Probe | A small anonymous Apex script the plan step runs with Streamline's `runAndRollback` to answer a question before choosing a candidate, such as whether an approach compiles, what a query returns, or how many limits it uses. Enabled per ascent by `ascent-init --planner-streamline` (up to 5 per plan) and independent of the mode. An ascent with them enabled is said to use planner probes. |
| Implement | The agent step that makes the planned edits to application files. |
| Learn | The agent step that runs after the keep or discard decision. It reads the plan, the diff and the score changes, then writes one learning to the history. |
| Candidate | The bundle of code edits an iteration tries, aimed at one weakness. |
| Run | One collection of raw inputs (deploy, analyzers, tests, logs) into a run folder, and the scores computed from it. |
| Mode | How runs collect their inputs from the org: deploy or Streamline. Chosen when the ascent starts and fixed for the whole ascent. Each mode has its own weights and settings in the ascent config. |
| Deploy mode | Deploys the application and test classes, then runs the Apex test classes with the sf CLI. The only mode that scores code coverage. |
| Streamline mode | Composes anonymous Apex scripts from the class files and runs them with Streamline, which rolls back the org afterwards. Nothing is deployed. Faster than deploy mode, but cannot score coverage or run static entry points. |
| Baseline | The scores of the code before the climb starts, or after the corpus selection changes. |
| Dimension | One measured aspect of the code, such as PMD or test run time. Each scores 0 to 100. |
| Score | A dimension's value from 0 to 100. 100 is perfect. |
| Penalty | The total a dimension's formula turns into a score, such as severity-weighted violations or seconds. |
| Severity weight | The penalty points one violation costs, by severity. |
| Half-score penalty | The penalty that scores exactly 50. Sets how strict a dimension is. |
| Limit headroom | How far one 200-record batch stays below its tightest governor limit. |
| Resource efficiency | How few governor-limit resources the tests use for the same work. |
| Overall score | The weighted mean of all dimension scores. The headline number, not the keep rule. |
| Gate | A check that hard-fails the iteration. A gated run scores 0 overall and is never kept. Today the only gate is compilation. |
| Evaluation cascade | The order of evaluation: compile, then static analysis, then tests, then performance. A gate failure stops the cascade. |
| Focus | The dimensions a candidate aims to raise, stated by the planner before the run. |
| Deterministic dimension | A dimension that scores unchanged code the same on every run, such as PMD. A nondeterministic dimension varies between runs of unchanged code, such as test run time on a shared Salesforce org. Every dimension is classified as one or the other. |
| Margin | The smallest change in a dimension's score that counts as a real rise or fall. For a nondeterministic dimension it is the noise band, measured from the spread of repeated unchanged baseline runs. For a deterministic dimension any change is real, so the margin is the smallest change worth keeping, set from known changes or 0. |
| Keep / discard | The outcome of an iteration. Keep when the focus dimensions rise and nothing else falls, each by more than its margin. A candidate that only misses its focus is still kept when the overall score rises by more than the largest weighted margin of any one dimension. |
| Sample tests | Test classes the agent can read but not edit. Listed under `testClasses.sample` in the ascent config. |
| Holdout | Test classes the agent can neither see nor edit. Listed under `testClasses.holdout` in the ascent config. They run and score with the sample tests. |
| Application files | The Apex classes under improvement. Excludes test classes and test fixtures. |

## Anchor

Optional steps that turn one ascent's behaviour drift into fixed tests, code and spec, in order. An ascent runs the same with or without them. See [anchor.md](anchor.md#anchor).

1. **Scout ascent.** Any completed ascent whose drift is used as the input to the anchor. Nothing marks an ascent as a scout in advance, so a first ascent run without an anchor can become a scout later.
2. **Audit.** An agent step with a pre-built prompt compares the baseline code, the final code, the kept diffs, the tests and the spec, if there is one. It records findings in a Zod-validated JSON file.
3. **Verify.** For each behaviour change, an agent writes seed data, and the harness runs the baseline and final classes on it in separate Streamline rollbacks and compares their outputs. Each finding gets a verify status of reproduced, not reproduced, skipped or error.
4. **Decide.** The user reviews the findings on an HTML page and gives each one a decision from the options its kind allows: preserve, fix, clarify, add-test or reject.
5. **Apply.** An agent writes the tests and spec edits the decisions call for. The next ascent measures its baseline with them.
6. **Track.** Later ascents check whether the closed gaps stay closed.
