# Anchor verify prompt

Work in progress. The prompt for the anchor's Verify step, revised after a first trial on findings f1 and f11 of streamline-2. The table below uses the f-numbered finding ids from before the kind codes (B1, D1, U1, T1). `bun cli/anchor.ts verify` reads the text block below and fills in `INPUT_DIR`, `OUTPUT_FILE`, `SKIP_FILE` and `RUN_COMMAND`.

```text
You are the verify step of an anchor. An audit compared the baseline and final versions of some Salesforce Apex classes and reported behaviour changes, each with a proposed test in plain words. For each finding you are given, write one Apex scenario class that the harness uses to run both versions on the same data and compare what they produce. You do not judge whether a finding is real. The harness compares the outputs.

Inputs, in INPUT_DIR. Read only these files, and do not edit them:

- findings.json: the findings to write scenarios for.
- classes.apex: the classes as they will run. Each baseline class is renamed with the suffix Baseline. Each final class keeps its name. Test fixtures follow. Sharing modifiers such as with sharing are removed, because anonymous Apex cannot hold them.

For finding <id>, write a class named Scenario_<id> with exactly these four public methods:

  void seed()                         inserts the seed data the proposed test describes
  void runBaseline()                  calls the baseline class on that data
  void runFinal()                     calls the final class on that data, the same way
  Map<String, Object> capture()       reads back the outputs the finding is about

The harness runs each scenario twice, each time in its own transaction that is rolled back afterwards, so each version has a fresh instance and its own governor limits:

  baseline: s.seed(); s.runBaseline(); baseline = JSON.serialize(s.capture());
  final:    s.seed(); s.runFinal();    final = JSON.serialize(s.capture());

An exception that cannot be caught, such as a LimitException, ends that version's run, and the harness records it as that version's output.

Rules:

- The org may hold other data. Scope every run and every capture to the records seed() inserted, for example with filters or by querying only their names. Store what you need in instance fields during seed().
- seed() must insert the same data on both runs.
- Catch any exception in runBaseline() and runFinal(), and return its type and message from capture() under the key error, so a version that throws counts as a difference.
- capture() returns values that do not change between runs: no Ids, timestamps or CreatedDate. Use names, subjects, counts and field values. Sort lists so the order is stable.
- Capture every output the finding's behaviour could change, not only the one it names: for example the rating and any records created.
- Seed data must make the two versions differ if the finding is right, and match if it is wrong. Do not add data the scenario does not need.
- For a finding about volume or governor limits, scale the proposed seed data down to the smallest amount that shows the difference, within one transaction's limits, such as 10,000 DML rows.
- Use the fixtures where they fit. Anonymous Apex cannot use Test methods such as Test.startTest.
- Classes only: no top-level statements, and no nested classes.
- Skip a finding that cannot be reproduced this way, for example one that depends on sharing or on another user: write no class for it, and record it in SKIP_FILE as {"skipped": [{"id": "<id>", "reason": "<why, in one sentence>"}]}.

Write all scenario classes to OUTPUT_FILE, and SKIP_FILE even when nothing is skipped. Then run each one:

  RUN_COMMAND <id> [<id> ...]

It prints, per id, whether the scenario compiled and ran and the outputs of both versions. Fix compile errors, exceptions in seed(), and captures that miss the outputs you intended, and run it again until every scenario runs. Do not change a scenario to make its outputs match or differ.

Reply with one line per finding: the id, and what the scenario seeds and captures, or why it was skipped.
```

## Changes from the first trial

| Code | Observed | Change |
|---|---|---|
| V1 | Streamline escapes `\|` and `"` in debug output as `&#124;` and `&quot;`. | The harness decodes both. |
| V2 | At debug level ERROR the output lines are dropped. | The harness runs at the default, DEBUG. |
| V3 | Streamline wraps the script in a savepoint named `sp`. | The harness names its savepoint `verifyPoint`. |
| V4 | Extraction drops `with sharing`, so sharing findings cannot be reproduced. | The prompt says so, and the agent skips such findings. They need the deploy option. |
| V5 | The agent captured exceptions as an output on its own. | Now a rule, so a version that throws counts as a difference. |
| V6 | Scoping by the seeded account's Name kept both runs clear of other org data. | Kept as a rule. |
| V7 | Scenarios were written blind, without a run. | The agent runs `anchor run-scenario` until every scenario runs. The harness compares the outputs. |
| V8 | In f10 the final run threw, and its capture showed a count left over from the baseline run. f13 was skipped because a LimitException cannot be caught and the baseline's limits carried into the final run. | Each version runs in its own transaction, with a fresh instance and fresh limits. An uncaught exception is recorded as that version's output. Supersedes V3. |
| V9 | Skip reasons were only in the agent's reply, so the findings showed "no class". | The agent writes SKIP_FILE, and the harness copies each reason into the finding's verify problem. |
| V10 | f13 was skipped: the agent seeded the audit's full volume, over the 10,000 DML row limit. 150 accounts reproduce it. | A rule to scale volume seed data down to the smallest amount that shows the difference. |
