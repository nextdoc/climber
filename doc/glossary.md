# Glossary

| Term | Meaning |
|---|---|
| Ascent | The loop of iterations from a baseline: each one tries a candidate, scores it, and keeps or discards it. It ends after K consecutive discards or when stopped. |
| Iteration | One step of an ascent: plan a candidate, apply it, run, score, then keep or discard it. One CLI invocation runs one iteration. |
| Candidate | The bundle of code edits an iteration tries, aimed at one weakness. |
| Run | One collection of raw inputs (deploy, analyzers, tests, logs) into a run folder, and the scores computed from it. |
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
| Margin | The smallest change in a dimension that counts as a real rise or fall, above run-to-run noise. |
| Keep / discard | The outcome of an iteration. Keep when the focus dimensions rise and nothing else falls, each by more than its margin. |
| Holdout | Test classes the agent can neither see nor edit. |
| Application files | The Apex classes under improvement. Excludes test classes and test fixtures. |
