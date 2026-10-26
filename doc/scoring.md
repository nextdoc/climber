# Scoring

Every dimension scores from 0 to 100. 100 is perfect. Scores approach 0 as code gets worse.

Each dimension turns a tool's raw output into a score. The tool reports a list of problems, each with a severity. Each problem costs penalty points by severity, and the points add up to one total, the penalty `P`. The formula `100 × K / (K + P)` turns the penalty into a score: 0 points scores 100, and more points push the score closer to 0. Fixing any problem lowers the penalty and raises the score.

The half-score penalty `K` is the penalty that scores exactly 50. It sets how strict a dimension is. A smaller `K` is strict: a few problems halve the score. A larger `K` is lenient: it takes many problems to halve the score. Each dimension sets its own `K` to the penalty it considers half as good as perfect.

## Dimensions

Example, the PMD baseline: PMD reports 6 High, 12 Moderate and 10 Low violations in `AccountHealthRollup.cls`. The penalty is `P` = 6 × 8 + 12 × 4 + 10 × 2 = 116. With `K` = 50, the score is 100 × 50 / (50 + 116) = 30.1.

| Dimension | Source | Half-score penalty `K` | Baseline penalty `P` | Baseline score |
|---|---|---|---|---|
| PMD | `sf code-analyzer run --rule-selector pmd` | 50 | 116 | 30.1 |
| Graph Engine | `sf code-analyzer run --rule-selector sfge` | 50 | 148 | 25.3 |

- Severity weights, the penalty points per problem:

  | Severity | Level | Weight |
  |---|---|---|
  | 1 | Critical | 16 |
  | 2 | High | 8 |
  | 3 | Moderate | 4 |
  | 4 | Low | 2 |
  | 5 | Info | 1 |

- Only violations in application files count: `force-app/**/classes/*.cls`, excluding `*Test.cls` and `Fixtures.cls`.
- The Graph Engine starts from `AccountHealthRollup.rateAll()` (`@InvocableMethod`). Refactors that move logic out of its reach, such as Batch Apex, can raise the score without improving the code.

### Tests

Source: `sf apex run test -n AccountHealthRollupTest --code-coverage --result-format json`.

| Dimension | Formula | Baseline | Baseline score |
|---|---|---|---|
| Tests passing | `100 × passing / ran` | 13 of 13 pass | 100 |
| Test run time | `100 × K / (K + P)`, `P` = seconds, `K` = 40 | 60.5 s | 39.8 |

- Test run time reuses the half-score formula with seconds as the penalty. `K` = 40 s was the run time before the headroom test was added. The headroom test raised it to about 60 s.
- Run time is noisy between runs (41 to 46 s before the headroom test). `K` and the keep margin should be set from repeated unchanged runs.
- Coverage is recorded but not scored.

### Governor limits

Two dimensions come from the test run's debug log. Each test's `TESTING_LIMITS` block records the limits used between `Test.startTest()` and `Test.stopTest()`, so fixture setup does not count. Both read the same limits: SOQL queries, query rows, DML statements, DML rows and CPU time. Heap is excluded because `TESTING_LIMITS` always reports it as 0.

They answer different questions. Limit headroom asks whether the worst case stays safely under every limit. Resource efficiency asks whether the same work uses fewer resources.

#### Limit headroom

Source: one test, `headroomAt200Accounts`, which rates a single batch of 200 accounts.

The score is the headroom left on the tightest limit: `100 − peak percent`. A batch using nothing scores 100. A batch at the limit scores 0. If the test has no `TESTING_LIMITS` block, for example because it hit a limit and failed, the score is 0.

| Limit | Baseline used | Limit | Percent of limit |
|---|---|---|---|
| SOQL queries | 5 | 100 | 5.0 |
| Query rows | 3,123 | 50,000 | 6.2 |
| DML statements | 2 | 150 | 1.3 |
| DML rows | 201 | 10,000 | 2.0 |
| CPU time (ms) | 9,525 | 10,000 | **95.3** |

Baseline score: 100 − 95.3 = 4.7. One batch of 200 accounts nearly exhausts the CPU limit.

#### Resource efficiency

Source: every other test with a `TESTING_LIMITS` block. The headroom test is excluded so the two dimensions stay independent.

The penalty is the percent of each limit used, summed over those tests, then added up across limits. `K` = 170, roughly the baseline penalty.

| Limit | Baseline used | Limit | Percent of limit |
|---|---|---|---|
| SOQL queries | 53 | 100 | 53.0 |
| Query rows | 8,195 | 50,000 | 16.4 |
| DML statements | 20 | 150 | 13.3 |
| DML rows | 570 | 10,000 | 5.7 |
| CPU time (ms) | 9,346 | 10,000 | 93.5 |
| **Penalty `P`** | | | **181.9** |

Baseline score: 100 × 170 / (170 + 181.9) = 48.3.

- CPU time is noisy (83.8 to 96.3 percent across runs). The other limits are counts and repeat exactly.

## Overall score

Weighted mean of the dimension scores, 0–100.

`overall = Σ (weight × score) / Σ weight`

| Dimension | Weight |
|---|---|
| PMD | 1 |
| Graph Engine | 1 |
| Tests passing | 1 |
| Test run time | 1 |
| Limit headroom | 1 |
| Resource efficiency | 1 |

Gate: if the code fails to compile, the run is gated and the overall score is 0. Failing tests are not a gate. They lower the Tests passing score.

Baseline overall: 41.4.

## Collecting inputs

`npm run score:prepare` runs `cli/score-prepare.sh`, which writes a run folder at `target/tmp/score/`:

1. `deploy.json`: deploys `force-app` to the org. A failed deploy is the compile gate, and collection stops.
2. `pmd.json` and `sfge.json`: Code Analyzer results.
3. `tests.json`: the Apex test results.
4. `logs/`: the test run's debug log, captured with the `ClimbScore` debug level and a one-hour trace flag that the script creates or renews.

`npm run score` scores the run folder.
