# Mapping

**Maturity: early.** The [commands](#commands) below are built and tested against the three sample classes, and have been tried on one real org with 55 groups.

Mapping charts the landscape of an org's Apex codebase as a treemap. Each group of classes and tests is a rectangle sized by its lines of code and coloured by its score. A large red rectangle is a lot of code scoring poorly, which is where climbing is likely to pay off most.

![The scored map of the three sample classes, with the dimension scores of Account health in the hover](images/map.png)

The scored map of the three sample classes. Hovering a group shows its classes, tests, line counts and the score of each dimension.

## Process

Steps to map a repo. To map another repo, run them from climber with `--root` pointing at that repo.

1. **Gather.** Create `map.json`, then run `map check` and `map render`.
   - `map gather` selects the Apex files to map and groups them by class name only, with no agent, as a first pass for refining. See [Default grouping](#default-grouping).
   - Tests and fixtures that several groups use land in `unassigned`.
   - Generated code can dominate the chart.
   - Instead, an agent or the user can write `map.json` by hand, following the [schema](#mapjson). A map without `source` still works, but the unmapped classes table then only finds classes in folders that hold a mapped class.
   - `map check` validates the map, however it was created.
   - `map render` writes `before.html`, a treemap. Each rectangle is a group, its area is the non-blank lines in the group's classes and tests, and together the rectangles fill one outer rectangle that stands for the whole org.
2. **Refine.** An agent or the user edits `map.json`: placing each unassigned class in the group whose code it tests, merging groups by business area and adding descriptions. Classes that are unclear stay in `unassigned`.
   - Shared test utilities go in a `testing` group. It is infrastructure: scored on static analysis only and not climbed.
   - A fixture that only one group's tests use goes in that group's `fixtures`.
3. **Tag.** The user names facets, such as version or business area, and an agent infers each group's value from the code. See [Tagging](#tagging).
   - The agent sets a value it can't infer to `unknown` rather than guessing.
   - Each tag renders as a coloured pill. Clicking one fades the groups without that tag, and Clear at the top right resets the filter.
4. **Approve.** The user reviews `before.html`, corrects the grouping and approves the map by setting `"approved": true` in `map.json`. An approved map has no unassigned classes.
5. **Score.** Run `map score <name> -o <org>`, then `map render <name> --scores`. See [Scoring in one pass](#scoring-in-one-pass).
   - Each group is scored with the same dimensions and weights as an ascent baseline.
   - `map score` runs the map's test classes, PMD and Graph Engine once against the code already in the org, then slices the outputs per group.
   - Scoring again after regrouping reuses the run without calling the org. `--fresh` runs it again.
   - `after.html` colours each rectangle by its group's overall score, from green at 100 to red at the lowest group score.
6. **Choose.** The user uses the chart to pick the groups worth climbing.

```mermaid
flowchart TD
  C[/"Apex classes selected by globs and ignores"/] --> G[1. map gather]
  G --> M[/"map.json: groups by name matching, and unassigned classes"/]
  M --> A[2. Agent or user: merge groups by business area, place unassigned classes, add descriptions]
  A --> TG[3. Agent: tag groups]
  TG --> K[1. map check]
  H[1. Agent or user: write map.json by hand] --> K
  K --> M2[/"map.json"/]
  M2 --> B[1. map render]
  B --> T[/"before.html: sized by lines"/]
  T --> U{4. User reviews}
  U -->|edit groups| A
  U -->|approve| S[5. map score]
  S --> R[/"scores.json: a score per group"/]
  R --> AF[5. map render --scores]
  M2 --> AF
  AF --> TC[/"after.html: sized by lines, coloured by score"/]
  TC --> P[6. User chooses which groups to climb]
```

## Commands

Each command takes the map's name, like the ascent CLIs, and works in the map's folder (see [Output naming](#output-naming)).

| Command | Reads | Writes |
|---|---|---|
| `map gather <name> <globs...> [-i <globs...>]` | the class files the globs select | `map.json` |
| `map check <name>` | the map and the class files | nothing, prints any errors |
| `map render <name>` | the map and the class files | `before.html` |
| `map score <name> -o <org>` | the map, the class files and the org | `scores.json` |
| `map render <name> --scores` | the map, the class files and the scores | `after.html` |

- `map gather` selects `.cls` files with include globs, then drops any that match an `-i, --ignore` glob. Globs are relative to `--root`, which defaults to the current folder. For example, `map gather sales 'force-app/**/classes/*.cls' -i '**/*Mock*.cls'`. It groups them as [Default grouping](#default-grouping) describes. The map records the root and globs it was gathered from, so it can be gathered again the same way.
- `map check` validates the map against the schema, which rejects a class in two groups and an approved map with unassigned classes, and checks that every class it names exists exactly once under the root. `map render` and `map score` run the same checks first.
- `map render` never writes to the map file. Line counts are worked out on every render.
- `map score` refuses a map that isn't approved. It collects its inputs once for the whole map and slices them per group, as [Scoring in one pass](#scoring-in-one-pass) describes.
- `map render --scores` warns when a group's classes or tests differ from the ones it was scored with.

### Quoting globs

Quote each glob so `map gather` receives the glob itself and records it in the map. Use single quotes in bash, zsh and PowerShell, and double quotes in cmd.exe. `map gather` accepts `\` as well as `/`, and drops the single quotes cmd.exe passes on.

| Shell | Unquoted glob |
|---|---|
| bash | Passed on unchanged when it matches nothing. Without `globstar`, `**` acts as `*`. With `globstar`, it is expanded into files. |
| zsh | Expanded into files. With no match, zsh stops with `no matches found` before `map gather` runs. |
| PowerShell, cmd.exe | Passed on unchanged |

Files from an expanded glob gather the same groups, but the map records the files instead of the glob, so a later gather misses new classes. `map gather` warns when an argument names a file and holds no glob characters.

## Default grouping

`map gather` groups the selected classes with these rules, in order:

1. A class with an `@isTest` annotation outside comments is a test class. Every other class is an app class.
2. Each app class starts its own group. The group's id is the class name in kebab case, such as `account-health-rollup`, and its name is the class name.
3. A test class joins the group of the app class whose name it matches once a `Test` prefix or suffix is removed, with or without an underscore, ignoring case: `FooTest`, `Foo_Test`, `TestFoo` and `Test_Foo` all match `Foo`.
4. An app class that no test is named after, and that only test classes refer to, is a fixture. When all of those test classes belong to one group, it moves into that group's `fixtures`, and the group it started is dropped. References are matched case-sensitively, so a variable named `fixtures` doesn't count as a reference to `Fixtures`.
5. Anything left over goes in `unassigned`: test classes that match no app class, and fixtures used by tests in several groups.

The agent or user then places the unassigned classes, merges groups that belong to one business area, and adds descriptions. `map check` accepts a map with unassigned classes, but approving the map requires that none are left.

## Output naming

Each map gets its own folder, `target/map/<name>/`:

```text
target/map/<name>/
├── map.json         map gather
├── run/             map score: the raw outputs of one test and analyzer run
├── runs/<id>/       map score: each group's slice of run/
├── scores.json      map score
├── before.html      map render
└── after.html       map render --scores
```

`--map <file>` on `render` and `score` reads a map from elsewhere, such as the committed `config/map.sample.json`, while the outputs still go to the named folder.

## Decisions

- D1: Zod schemas define the map and the scores files, and every mapping tool reads and writes them through those schemas.
- D2: Each group has an `id`: a kebab-case slug set when the group is created, by `map gather` from the class name or by whoever adds the group. The schema requires ids to be unique. An id never changes, so renaming a group or moving classes between groups keeps its score attached.
- D3: Red marks the lowest group score, not 0.
- D4: Scoring is best effort. A dimension a group can't be scored on, such as limit headroom without a headroom test, gets weight 0 for that group, and the group's score records which dimensions it skipped.
- D5: Scoring runs the tests already in the org and never deploys. It scores like deploy mode, except that the tests running stands in for the deploy's compile gate.
- D6: One command, `map score`, scores every group. It replaces an earlier design in which an agent scored the groups one at a time. Agents run it once and never loop it per group.
- D7: The map file holds only what the agent and user decide: the groups. Line counts are derived on render, and scores live in `scores.json`.
- D8: Tagging uses facets: one value per facet per group, so each facet is one way to categorise the groups and a group can't hold two values for it.

### Scoring in one pass

**Status: built.** These decisions replaced running `cli/score-prepare.sh` once per group, based on a full test run against a real org.

- D9: `map score` collects its inputs once for the whole map and slices them per group. It calls `sf` from TypeScript with no script. `cli/score-prepare.sh` stays for ascents.
- D10: The test run covers only the approved map's test classes, so a developer can map one area of a large org without running every test.
- D11: The run uses `--code-coverage --detailed-coverage`. Its `coverage.records` give the covered lines per test method and class, so a group's coverage is the union of lines its own tests cover. Coverage from other groups' tests never counts.
- D12: A group's tests passing and test run time come from its test classes' method results, including their setup methods.
- D13: The org writes one debug log per test class. Logs are fetched by id with several in parallel, because `sf apex get log --number` stops at 25. Each log goes to the group that owns its test class.
- D14: Limit parsing drops a namespace prefix from test names, so `ns.ClassTest.method` counts as `ClassTest.method` in a namespaced org.
- D15: PMD and Graph Engine run once over all mapped classes. Every violation names its file, so the existing per-file filter splits them by group.
- D16: The raw outputs stay in `target/map/<name>/run/`. Scoring again after regrouping slices them again without calling the org, and `--fresh` collects them again.
- D17: `map score` creates the analyzer log folder that `code-analyzer.yml` names, `target/tmp/code-analyzer/logs`, under the target repo's root.

Measured on an org with 308 tests in 41 test classes and 55 groups:

| Step | Wall-clock |
|---|---|
| Tests with detailed coverage | 40 s |
| 41 logs, fetched 8 at a time | 13 s |
| PMD over 54 classes | 5 s, 81 s on a cold first run |
| Graph Engine over 54 classes | 7 s |

Scoring group by group would have taken 30 to 60 minutes, almost all of it per-run overhead. Two limits remain:

- Graph Engine can fail on some entry points with an internal error. Those entry points report no violations, the same as in a per-group run.
- Test classes run in parallel in one job, so run times can differ from a group's tests run alone.

## map.json

The Zod schema `ProjectMap` in `cli/lib/map.ts` defines the file. `config/map.sample.json` maps the three sample classes. `headroomTest` is optional.

### Tagging

Tagging is optional. A group's `tags` holds one value per facet, such as `{ "version": "v3", "area": "rendering" }`, so each facet is one way to categorise the groups. The user names the facets and an agent infers their values from the code. The page gives each tag its own colour and shows it as a pill on each rectangle and in the hover. Clicking a pill fades every group without that tag. The filter shows at the top right, with Clear to reset it. While a filter is on, a checkbox below it hides those groups instead of fading them and lays the treemap out again with the remaining groups.

```json
{
  "approved": false,
  "source": { "root": ".", "include": ["force-app/**/classes/*.cls"], "ignore": [] },
  "unassigned": [],
  "groups": [
    {
      "id": "account-health",
      "name": "Account health",
      "description": "Rates accounts and creates follow-up tasks.",
      "classes": ["AccountHealthRollup"],
      "tests": ["AccountHealthRollupTest"],
      "fixtures": ["Fixtures"],
      "headroomTest": "AccountHealthRollupTest.headroomAt200Accounts"
    }
  ]
}
```

## scores.json

A `MapScores` schema defines the file, keyed by group id. Each entry records the classes and tests it scored, so a later render can tell when the group has changed.

```json
{
  "account-health": {
    "overall": 51.7,
    "dimensions": { "PMD": 40, "Code coverage": 91.2 },
    "skipped": [],
    "classes": ["AccountHealthRollup"],
    "tests": ["AccountHealthRollupTest", "Fixtures"],
    "run": "target/map/map.sample/runs/account-health",
    "scoredAt": "2026-11-02T16:00:00.000Z"
  }
}
```

## Treemap

Vega has a treemap transform. Vega-Lite does not, so the chart is a Vega spec. The report page already loads Vega 5.30.0. Before scoring, rectangles share one neutral colour.

## Unmapped classes

Below the treemap, both pages list every Apex class that isn't in a group, so the chart's coverage of the codebase is visible. `map render` finds them in two places:

- the files the map's `source` globs select, plus the files its ignore globs drop
- every `.cls` file in a folder that holds a mapped class, which covers maps written by hand without a `source`

| Column | Content |
|---|---|
| Class | the class name |
| Path | the file, relative to the root |
| Kind | app or test, by the `@isTest` rule in [Default grouping](#default-grouping) |
| Lines | non-blank lines |
| Reason | `unassigned`: in the map's `unassigned` list. `ignored`: dropped by an ignore glob. `not in map`: found by the globs or in a mapped folder, but in no group, such as a class added since the map was gathered |

The page header shows mapped and unmapped line totals. When every class is mapped, the table says so.

## Assumptions and side effects

Mapping assumes the source it reads has been deployed to the org it scores. Deploying is the user's job, not mapping's. If the source and the org differ, PMD and Graph Engine score the local files while the tests run the org's code, and a group's score mixes the two.

Mapping makes no changes to code, metadata or business data. Its only side effects come from running tests:

- Apex tests roll back their data. The org keeps the test results and updates its stored code coverage.
- Reading limit use needs debug logs, so scoring creates or updates a `DebugLevel` and a `TraceFlag` for the running user. The org keeps the resulting `ApexLog` records.

## Open questions

- Q1: Do rectangles nest, with groups split into classes and tests or into individual classes, or is each group one flat rectangle?
- Q2: Should line counts also exclude comments? They exclude blank lines now.
- Q3: Does mapping read the repo's source only, or also the org, for classes that aren't in the repo?
