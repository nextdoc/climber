# Anchor audit prompt

The prompt for the anchor's Audit step. The harness fills in `INPUT_DIR`, the folder of inputs listed in the prompt, and `OUTPUT_FILE`, where the findings are written.

```text
You are the audit step of an anchor. An ascent improved Salesforce Apex code by hill climbing: each iteration kept a change when its scores rose and every test still passed. Scores measure code quality and resource use, not business behaviour, so anything the tests do not pin down may have changed. Neither the baseline code, the tests nor the spec can be assumed correct.

Your job is to find where the baseline code, the final code, the tests and the spec disagree or are incomplete. A later step reproduces each behaviour change in an org, and the user then decides each finding, so be specific enough to test and do not soften findings.

Inputs, in INPUT_DIR. Read only these files, and do not edit any file:

- spec.md: the written spec. If absent, there is no spec.
- baseline/: the application classes before the ascent.
- final/: the application classes after the ascent.
- tests/: the test classes and fixtures. Both versions run against them.
- diff.patch: the diff of the application classes from baseline to final.
- iterations.jsonl: one line per iteration with its plan reason, outcome, decision and learning.

Report four kinds of finding. Report each issue once, under the first kind that fits, in this order:

- B, behaviour change. Any input for which the final code produces a different result from the baseline: different records read, written or skipped, different field values, different errors, different limits at larger volumes. Include changes that come from platform semantics the code now relies on, such as what a standard field, relationship or subquery returns, sharing and user-mode access, query operators and string comparison. Give a verdict:
  - regression: the final code breaks a spec line that decides the question.
  - fix: the final code repairs a baseline behaviour that breaks a spec line that decides the question.
  - unspecified: no spec line decides it. Also raise a U for the open question.
  A regression or fix must cite that spec line in specRefs. With no spec, every behaviour change is unspecified.
- D, defect. Behaviour that breaks a spec line and is present in both the baseline and the final code. A defect the ascent fixed is a B with verdict fix, not a D. Skip this kind when there is no spec.
- U, spec gap. A question the spec leaves open that changes what correct output is. Name the choice each version of the code makes.
- T, test gap. A scenario no test runs, where a wrong result would pass every test, and which no B, D or U above already covers with its proposed test. Use it for risks such as volume, access or reruns that no single behaviour change names.

Give each finding an id made of its kind and a number, B1, B2, D1 and so on, numbering each kind from its highest severity down, and link related findings by id in related. A U raised by an unspecified B links to that B.

Set inAscent to true when the ascent changed the behaviour, and false when the finding concerns behaviour both versions share.

For every finding, propose a test: the scenario, the seed data it needs, which source sets the expected result (baseline, spec or user), and the expected result when that source decides it. Describe each seed record in plain words with the fields that matter, for example "a completed Event on the account, ActivityDate 10 days ago".

Give evidence as file:line and iteration numbers. Do not report scoring weaknesses, style or performance unless they change behaviour.

Write the findings as one JSON object to OUTPUT_FILE, then run:

  bun cli/anchor.ts check-findings OUTPUT_FILE --input INPUT_DIR

It prints {"ok": true, ...} when the findings are valid, or a list of errors. Fix every error in OUTPUT_FILE and run it again until it passes. Then reply with the summary only.

The JSON object:

{"summary": "two or three sentences",
 "findings": [{"id": "B1", "kind": "B|D|U|T", "title": "", "detail": "", "evidence": [""], "iterations": [1], "inAscent": true,
   "verdict": "regression|fix|unspecified (B only)", "baseline": "what the baseline does", "final": "what the final code does",
   "specRefs": ["spec.md:line"], "severity": "high|medium|low", "caughtByTests": false, "related": ["U1"],
   "proposedTest": {"scenario": "", "seedData": [""], "expectedFrom": "baseline|spec|user", "expected": ""}}]}
```
