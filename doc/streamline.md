# Streamline

Status: draft. This records what has been proven so far. Sections marked open are undecided.

Streamline is an MCP server that runs anonymous Apex in an org and rolls the org back afterwards. An ascent can use it in two independent ways:

| Use | What it does | Decides keep or discard | Setting |
|---|---|---|---|
| Planner probes | The plan step runs small scripts to answer questions before choosing a candidate. | No | `ascent-init --planner-streamline` |
| Streamline mode | The harness runs composed scripts in place of a deploy and Apex test run to collect scoring inputs. | Yes | `ascent-init --mode streamline` |

Each is fixed when the ascent starts. Either can be on without the other, so ascents can be compared with and without each.

## Org safety

Streamline runs agent-written code as normal anonymous Apex, outside the isolation of Apex tests. Rollback undoes DML, but callouts, platform events published immediately and spent governor limits are not rolled back. So:

- `ascent-init` refuses planner probes and Streamline mode unless the target org is a scratch org listed by `sf org list`.
- In Streamline mode the harness calls Streamline itself and only ever passes the ascent's target org.
- Planner probes pass the org alias themselves. The prompt names the target org, but Streamline can reach any org the sf CLI is authorised for, so this is not enforced.

## Planner probes

With `--planner-streamline`, the plan step can run up to 5 anonymous Apex scripts with `runAndRollback` while it plans. A probe answers a question cheaply, such as whether an approach compiles, what a query returns, or how much CPU or how many queries an approach uses. Fewer candidates should then fail the compile gate or get discarded.

- Probes pass code inline, so they write no files.
- The plan step's agent command gets `--mcp-config` pointing at the repo's `.mcp.json`, because worktrees lack that gitignored file, plus the Streamline tools in `--allowedTools`.
- A probe tests only the isolated change, such as a query, an expression or a small method, with the few records it needs. It does not copy whole classes or call the org's application classes, which may not match the worktree. This keeps probes small and cheap.
- The plan's JSON lists each probe and what it showed, and the history records it.
- Only the harness score of the implemented candidate decides keep or discard.

Risks:

- Probes that rerun the test scenarios can pick a lucky result on a noisy dimension, or shape the code to the visible scenarios. The prompt forbids it.
- Deploy mode deploys holdout tests, so a probe could read their bodies from the org. Only the prompt forbids it.

## Streamline mode

Streamline mode runs each iteration's code as anonymous Apex in place of the deploy and Apex test run of deploy mode. Nothing is deployed. See [glossary](glossary.md).

It suits a fast early pass that makes the bulk of the gains cheaply. A later ascent in deploy mode then measures every dimension, including coverage and test run time, and confirms the code in the org before merging.

### Benefits and trade-offs

| Benefits | Trade-offs |
|---|---|
| Much faster iterations: no deploy, and the scripts run in about 23 s against about 60 s of tests plus a deploy. | Code coverage and test run time cannot be measured, so they are weighted 0. |
| The org never holds the candidate code. | CPU time reads about 30% lower than in Apex tests, so scores cannot be compared with deploy mode. |
| PMD and Graph Engine still analyse the `.cls` files. | Static entry points such as `@InvocableMethod` cannot run. |
| | Scenarios share data within a script, so they are less isolated than test methods. |

### Source of truth

The `.cls` files stay the source of truth. The agent edits them, PMD and Graph Engine analyse them, and kept changes are committed to them as in deploy mode. The harness composes Streamline scripts from them for each run.

### Composition

A script has three sections:

| Section | Content |
|---|---|
| `// === CLASSES ===` | The application and fixture classes, extracted from their `.cls` files, then the scenario classes. |
| `// === CODE ===` | Calls one scenario entry point. |
| `// === ASSERTIONS ===` | Fails the script when any scenario failed. |

#### Extraction

`cli/lib/extract.ts` parses a `.cls` file with `@apexdevtools/apex-parser` and adapts it for anonymous Apex through a pipeline of transforms. Each transform applies only when the class needs it.

| Transform | Change |
|---|---|
| `reject-unsupported` | Fails on nested types, static initializers and static non-final fields. Anonymous Apex cannot hold them and no rewrite keeps their meaning. |
| `drop-uncalled-static-methods` | Drops static methods the class never calls, such as `@InvocableMethod` entry points. |
| `static-to-instance` | Makes the remaining static methods and constants instance members, and drops annotations that require static. Fails when the class calls one as `ClassName.member`. |
| `drop-virtual-class` | Drops the `virtual` class modifier, since anonymous Apex classes are virtual by default. |

`AccountHealthRollup` loses only `rateAll`. `Fixtures` is copied unchanged.

#### Scenarios

The test methods are rewritten as scenarios in `apex/streamline/scenarios/`. One transaction cannot provision fresh data for every test within the DML row limit, so scenarios that only read the result of one provisioned run share it. `System.assertEquals` failures cannot be caught, so scenarios use their own assertion that throws a catchable exception, and each scenario reports its own result.

#### Config

The ascent config's `streamline` block defines what each run composes. Paths are relative to the worktree.

| Field | Meaning |
|---|---|
| `classes` | Globs of the classes to extract: application classes and fixtures |
| `scenarios` | The scenario classes file |
| `variants` | The `CODE` section statement per variant, e.g. `"correctness": "new AccountHealthRollupTest().runCorrectness();"` |
| `runCounts` | Test runs each measured scenario stands for in resource efficiency |

`headroomTest` names the test whose limit use scores limit headroom, in both modes. `ascent-init --mode streamline` sets code coverage and test run time to weight 0.

#### Run

Each run analyses with PMD and Graph Engine without deploying (`SKIP_DEPLOY` in `cli/score-prepare.sh`), writes `runs/<n>/<variant>.apex` (`cli/lib/compose.ts`), then runs each variant with `runFileAndRollback` (`cli/lib/streamline.ts`). The harness starts the Streamline server from `.mcp.json` as an MCP client, with `ALLOWED_DIRS` set to the run folder and the web UI off. A class the extractor cannot adapt gates the candidate as `extract`. A run takes about 40 s.

#### Variants

A variant is one composed script with one entry point. Each runs in its own transaction with its own governor limits.

| Variant | Data | Measures |
|---|---|---|
| `correctness` | 50 bulk + 6 scenario accounts | Every scenario, plus the limit use of the main run, the filtered run and the rerun |
| `headroom` | 194 bulk + 6 scenario accounts | Limit use of one 200-account batch |

They are split because one script running both came close to the 10 s CPU limit.

### Output

Scenarios write result lines to the debug log. Streamline returns `|` escaped as `&#124;`, and the scorer decodes it.

```
TEST|AccountHealthRollupTest.hotAccount|PASS
TEST|AccountHealthRollupTest.rateAllFromFlow|SKIP static @InvocableMethod is not allowed in anonymous Apex
LIMITS|AccountHealthRollupTest.headroomAt200Accounts|{"Maximum CPU time":{"used":7072,"limit":10000},...}
```

A run folder holds `streamline.json` (whether each variant compiled and succeeded), `logs/<variant>.log`, `pmd.json` and `sfge.json`.

### Scoring

`bun cli/score.ts -m streamline --headroom-test <test>` reads the run folder above.

| Dimension | Streamline input |
|---|---|
| PMD, Graph Engine | Unchanged |
| Tests passing | `TEST` lines. `SKIP` lines are not counted. A variant with an uncaught exception counts as one failing test. |
| Code coverage | Not available. Weight must be 0. |
| Test run time | Not available. Weight must be 0. |
| Limit headroom | The headroom scenario's `LIMITS` line |
| Resource efficiency | All other `LIMITS` lines, each multiplied by the number of test runs it stands for (`--run-counts`) |

The compile gate fails when any variant fails to compile.

### Comparison with deploy mode

The same code, scored both ways with coverage and run time at weight 0:

| | Deploy | Streamline |
|---|---|---|
| Time | 62.6 s tests, plus deploy | 6.3 s + 17.1 s |
| Tests passing | 13 of 13 | 12 of 12, 1 skipped |
| SOQL, query rows, DML, DML rows | Same | Same |
| Headroom CPU | 10,510 ms | 7,072 ms |
| Overall | 40.7 | 47.2 |

CPU time is about 30% lower in Streamline. Scores within one ascent stay comparable, but scores cannot be compared across modes.

### Limits

- Limits are per transaction and rollback does not refund them: 10,000 DML rows and 10 s CPU per variant.
- The org never receives the kept code, so an ascent needs one deploy and full test run before merging.

### Open

- Half-score values per mode.
- Whether scenarios are written by hand or generated from the test classes.
