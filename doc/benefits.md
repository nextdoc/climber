# Benefits

Why climb with a harness instead of asking one coding agent session to improve the code. An ordinary agent can use tests, version control and regression checks too. The difference is that this tool makes them properties of the system, not things the agent has to remember to do. The result is predictable progress, improvements that compound and bounded experiments, instead of open-ended trust in the agent.

The benefits come from three layers:

- **Agent reasoning.** Each agent step is small, focused and free of earlier transcripts.
- **Experiment discipline.** The harness controls the objective, the scope, the scoring and the decision to keep each change.
- **External orchestration.** The best code and what was learnt live in git and the ascent history, outside any agent session.

Benefits 1, 2, 3, 4 and 7 are the most distinctive. The others follow from them. The ranking is a judgement, not a measured result: for some code, objective scoring or reliable keep and revert may matter more than small context.

## 1. Small, focused agent context

Each step of an iteration is a separate agent process with a prompt the harness builds. The plan step gets the current scores, the static analysis findings and a summary of the last 10 iterations with their learnings, and reads the code it needs. The implement step gets only the plan's edits and reason. The learn step gets the outcome, the score changes, the patch and the changed findings, and no tools. No step inherits the reasoning, failed attempts or logs of an earlier one.

Agents reason better with less context, so each step gets more intelligence for its price, not only a lower cost and a faster run.

Evidence:

- [Lost in the Middle: How Language Models Use Long Contexts](https://arxiv.org/abs/2307.03172) (Liu et al., 2023): accuracy falls as input grows, and falls most for information in the middle of the context.
- [Context Rot: How Increasing Input Tokens Impacts LLM Performance](https://research.trychroma.com/context-rot) (Chroma, 2025): across 18 models, reliability drops as input length grows, and irrelevant content makes it worse.
- [LLMs Get Lost In Multi-Turn Conversation](https://arxiv.org/abs/2505.06120) (Laban et al., 2025): performance drops by about 39% on average when a task is spread over many turns, because models commit to early wrong assumptions and do not recover.
- [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) (Anthropic, 2025): recommends the smallest set of high-signal tokens for each model call, and sub-agents with clean context for long tasks.

## 2. Objective scoring, no self-grading

The planner, the implementer and the scorer are separate. The harness deploys each candidate, runs PMD, Graph Engine and the tests, and scores it on the dimensions, weights and margins fixed at `ascent-init`. The harness decides keep or discard, not an agent. An agent cannot redefine success, skip a regression or declare victory early.

The agent also cannot raise scores by weakening the tests. The implement step cannot run tests or deploy, and a change to a test or fixture is rejected. Holdout tests are hidden from the plan and implement steps, so a change that only satisfies the visible tests still fails.

Evidence:

- [Large Language Models Cannot Self-Correct Reasoning Yet](https://arxiv.org/abs/2310.01798) (Huang et al., 2023): without external feedback, models judge their own answers poorly and sometimes make correct answers wrong.
- [Recent Frontier Models Are Reward Hacking](https://metr.org/blog/2025-06-05-recent-reward-hacking) (METR, 2025): models modify tests or scoring code to get a high score.
- [ImpossibleBench: Measuring LLMs' Propensity of Exploiting Test Cases](https://arxiv.org/abs/2510.20270) (Zhong et al., 2025): given tests that contradict the spec, frontier models often make them pass with shortcuts, and stronger models do so more.

## 3. Kept improvements cannot be lost

An ascent runs in its own git worktree and branch. A kept candidate is committed. Anything else is reset to the last commit. The branch head is always the best code found so far, so a bad candidate cannot undo an earlier improvement, and the climb only goes up.

Evidence:

- [Karpathy's autoresearch](https://github.com/karpathy/autoresearch) (2026): the same loop of change, measure, then keep or revert with git, on a single metric.
- [AlphaEvolve](https://arxiv.org/abs/2506.13131) (Novikov et al., 2025): keeps scored programs in a database outside the model and builds new candidates from the best of them.

## 4. Fresh attempts instead of commitment to one approach

An ascent climbs one candidate at a time, so it does not run competing approaches side by side. But each plan step starts fresh from the current best code and its scores, not from the previous attempt's reasoning. A speculative candidate costs one iteration, because a discard reverts it, and a candidate that repeats a discarded patch is rejected without scoring.

Evidence:

- [LLMs Get Lost In Multi-Turn Conversation](https://arxiv.org/abs/2505.06120) (Laban et al., 2025): a long session locks in early assumptions.
- [AI Research Agents for Machine Learning: Search, Exploration, and Generalization in MLE-bench](https://arxiv.org/abs/2507.02554) (Toledo et al., 2025): treats agents as search policies over candidate solutions. A greedy policy that improves the current best solution is a strong baseline, and better operators raise it further.

## 5. Each iteration is an experiment

The plan step names one weakness, the dimensions it should raise and 1 to 6 edits. The harness records the outcome and the reasons for it, and the learn step records why it happened. A discard is informative: the history shows what was tried, which dimension moved and by how much.

Evidence:

- [Karpathy's autoresearch](https://github.com/karpathy/autoresearch) (2026): one bounded change per experiment, with every result logged, kept or not.
- [AIDE](https://arxiv.org/abs/2502.13138) (Jiang et al., 2025): code improvement as a search where each step proposes a change and is measured.

## 6. Protection against regressions

A candidate is kept only when its focus dimensions rise and no other dimension falls by more than its margin. Every test must pass, including the holdout tests. Raising one score at the expense of another is a discard, even when the focus improves.

Behaviour the tests do not pin can still change. The [anchor](anchor.md#anchor) finds those changes after an ascent.

Evidence:

- [Specification gaming: the flip side of AI ingenuity](https://deepmind.google/discover/blog/specification-gaming-the-flip-side-of-ai-ingenuity/) (Krakovna et al., DeepMind, 2020): optimisers satisfy the literal objective while missing the intended one.
- [Categorizing Variants of Goodhart's Law](https://arxiv.org/abs/1803.04585) (Manheim and Garrabrant, 2018): optimising a proxy breaks its link to the goal, more so the harder it is optimised.

## 7. Learning accumulates, context does not

The learn step writes one learning per iteration into `history.jsonl`. Later plan steps read the recent learnings instead of earlier transcripts, so they avoid dead ends without carrying the context that produced them. The retro reads the whole history at the end of the ascent.

Evidence:

- [Reflexion: Language Agents with Verbal Reinforcement Learning](https://arxiv.org/abs/2303.11366) (Shinn et al., 2023): agents improve by writing reflections on feedback into a memory that later attempts read.
- [ExpeL: LLM Agents Are Experiential Learners](https://arxiv.org/abs/2308.10144) (Zhao et al., 2024): insights extracted from past attempts improve later tasks, and performance rises as experience accumulates.

## 8. Noise is not mistaken for progress

Each dimension has a margin: the smallest change that counts as a real rise or fall. For nondeterministic dimensions, such as CPU time, the margin is measured from the spread of repeated unchanged baseline runs. A candidate whose gain is inside the noise is discarded, so the climb does not keep lucky measurements.

Evidence:

- [Statistically Rigorous Java Performance Evaluation](https://dri.es/files/oopsla07-georges.pdf) (Georges, Buytaert and Eeckhout, OOPSLA 2007): performance measurements on a managed runtime are nondeterministic, and comparisons that ignore the variation can reach wrong conclusions.
- [Categorizing Variants of Goodhart's Law](https://arxiv.org/abs/1803.04585) (Manheim and Garrabrant, 2018): selecting on a noisy measure also selects for its noise.

## 9. Small, attributable changes

Each kept candidate is one small commit named after its iteration and reason, so it is easy to review, revert or bisect. Each iteration also saves its patch, run folders keep the raw analyser and test output, and the ascent records its base commit. A score change can be traced to the one change that caused it and measured again. The agent's choices are not reproducible, but the code and its measurements are.

Evidence:

- [Modern Code Review: A Case Study at Google](https://research.google/pubs/modern-code-review-a-case-study-at-google/) (Sadowski et al., 2018): most changes at Google are small, and small changes get review feedback much faster than large ones.
- [Simplifying and Isolating Failure-Inducing Input](https://www.st.cs.uni-saarland.de/papers/tse2002/) (Zeller and Hildebrandt, 2002): isolating the effect of one change among many is expensive after the fact. Small, separately measured changes avoid that search.

## 10. Stop at any time

The branch head is always deployed, tested and scored. An ascent can stop after any iteration, by choice or by its stop rules, and leave usable code. More iterations buy more improvement, not a chance to finish.

Evidence:

- [Using Anytime Algorithms in Intelligent Systems](https://www.doi.org/10.1609/aimag.v17i3.1232) (Zilberstein, AI Magazine, 1996): anytime algorithms return a valid result whenever they are stopped, and trade computation time for quality.

## 11. Bounded, unattended runs

`bun cli/iterate.ts <name>` runs one iteration and reports `stop` when every dimension is within its margin of 100, when the ascent reaches `maxDiscards` discards in a row, or `plateauDiscards` discards in a row whose focus did not rise by more than its margins. Run it repeatedly until it stops, without supervision. Each iteration is bounded to one plan of 1 to 6 edits, and the history records each step's model, duration and cost.

Evidence:

- [Karpathy's autoresearch](https://github.com/karpathy/autoresearch) (2026): runs experiments unattended overnight, each with a fixed time budget.

## 12. Cheaper models, any agent CLI

Each step has its own model and command in `ascent.config.json`. By default the plan step uses Opus, while the implement and learn steps use Sonnet, because their tasks are narrow and the harness checks the result. The command is any shell command that reads the prompt on stdin and prints the reply, so other agent CLIs can plug in. Cost is recorded for Claude Code's JSON output only. This repo has not measured how far smaller models can go.

Evidence:

- [Large Language Monkeys: Scaling Inference Compute with Repeated Sampling](https://arxiv.org/abs/2407.21787) (Brown et al., 2024): with an automatic verifier, repeated attempts by a cheaper model can beat a single attempt by a stronger one at lower cost.

## 13. Progress at a glance

The [report](../README.md) shows the gain on the baseline, the climb over time, each iteration's outcome and duration, and the cost per step. It is built from the history, so it can be rebuilt at any point during or after an ascent.

No external evidence. This is a product feature, not a research claim.

## Not claimed

- **Parallel exploration.** Independent agents trying different candidates against the same baseline would fit the design, but an ascent runs one candidate at a time.
