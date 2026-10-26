# Caveats

- **C1:** High debug log levels during test runs add overhead, mostly CPU time, so the tests use more resources than they would with logging off. Resource efficiency is used as a relative measure, comparing one run against another. As long as the log levels stay the same within one ascent, the overhead is the same in every run, and a change in score still reflects a change in the code.
- **C2:** PMD and the Graph Engine run with their default rules and settings, and every dimension has an equal weight. These are starting defaults, not a recommended recipe. Teams will likely want to customise the rule selection, severity weights, half-score penalties and dimension weights for their own code.
