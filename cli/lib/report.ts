import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { ascentDir, kept, loadConfig, loadHistory, REPO_ROOT, type AscentConfig, type HistoryEntry } from "./ascent.ts";

const TEMPLATE = join(REPO_ROOT, "cli/report.html");

const PLACEHOLDER = "/*DATA*/null";

const HOUR = 3_600_000;

const STEPS = ["plan", "implement", "learn"] as const;

const round = (x: number, digits = 2) => Number(x.toFixed(digits));

/** Least squares slope and intercept of [x, y] points. */
function fit(points: [number, number][]) {
  const n = points.length;
  const mx = points.reduce((s, [x]) => s + x, 0) / n;
  const my = points.reduce((s, [, y]) => s + y, 0) / n;
  const sxx = points.reduce((s, [x]) => s + (x - mx) ** 2, 0);
  const sxy = points.reduce((s, [x, y]) => s + (x - mx) * (y - my), 0);
  const slope = sxx === 0 ? 0 : sxy / sxx;
  return { slope, intercept: my - slope * mx };
}

const hasScores = (e: HistoryEntry) => Object.keys(e.scores ?? {}).length > 0;

export function reportData(config: AscentConfig, history: HistoryEntry[]) {
  const dir = ascentDir(config.name);
  const baseline = history.find((e) => e.outcome === "baseline");
  if (!baseline?.scores || baseline.overall === undefined) throw new Error(`Ascent ${config.name} has no scored baseline`);
  const start = Date.parse(baseline.at);
  let state = baseline.scores;
  let current = baseline.overall;

  const rows = history
    .filter((e) => e.outcome !== "baseline")
    .map((e) => {
      const scored = hasScores(e);
      const deltas = scored
        ? Object.fromEntries(Object.entries(e.scores!).map(([d, score]) => [d, round(score! - state[d]!, 1)]))
        : undefined;
      if (e.outcome === "keep" && !e.dryRun) {
        state = e.scores!;
        current = e.overall!;
      }
      return {
        iteration: e.iteration,
        at: e.at,
        outcome: e.outcome,
        dryRun: e.dryRun,
        overall: scored ? e.overall : undefined,
        current,
        hours: round((Date.parse(e.finishedAt ?? e.at) - start) / HOUR, 3),
        minutes: e.finishedAt === undefined ? undefined : round((Date.parse(e.finishedAt) - Date.parse(e.at)) / 60_000, 1),
        focus: e.focus ?? [],
        reason: e.reason,
        decision: e.decision ?? [],
        learning: e.learning,
        deltas,
        patch: e.patch && relative(dir, e.patch),
        run: e.run && relative(dir, e.run),
        cost: Object.fromEntries(STEPS.map((s) => [s, e.steps?.[s]?.costUsd ?? 0]))
      };
    });

  const climb = rows.filter((r) => !r.dryRun);
  const last = climb.at(-1);
  const perHour = fit([[0, baseline.overall], ...climb.map((r): [number, number] => [r.hours, r.current])]);
  const timed = climb.filter((r) => r.minutes !== undefined);
  const hours = last?.hours ?? 0;

  const totals = Object.fromEntries(STEPS.map((s) => [s, 0]));
  const series = STEPS.map((step) => ({ hours: 0, step, usd: 0 }));
  // One point per step at each finish keeps x unique within a step, which Vega-Lite stacking requires.
  for (const r of rows) {
    for (const step of STEPS) {
      totals[step] += r.cost[step];
      series.push({ hours: r.hours, step, usd: round(totals[step], 4) });
    }
  }

  return {
    ascent: {
      name: config.name,
      mode: config.mode,
      plannerStreamline: config.plannerStreamline,
      targetOrg: config.targetOrg,
      branch: config.branch,
      baseCommit: config.baseCommit,
      createdAt: config.createdAt,
      updatedAt: history.at(-1)!.finishedAt ?? history.at(-1)!.at
    },
    summary: {
      baseline: baseline.overall,
      current,
      gain: round(current - baseline.overall),
      iterations: climb.length,
      kept: climb.filter((r) => r.outcome === "keep").length,
      hours: round(hours),
      perHour: round(perHour.slope),
      perIteration: climb.length ? round((current - baseline.overall) / climb.length) : 0,
      angle: climb.length ? round((Math.atan((current - baseline.overall) / climb.length) * 180) / Math.PI, 1) : 0,
      minutesPerIteration: timed.length ? round(timed.reduce((s, r) => s + r.minutes!, 0) / timed.length, 1) : null,
      // Trimmed at both ends so the line clears the start and current score labels.
      fit: [0.1, 0.9].map((t) => ({ hours: hours * t, fit: round(perHour.intercept + perHour.slope * hours * t) }))
    },
    cost: {
      total: round(STEPS.reduce((s, step) => s + totals[step], 0)),
      byStep: Object.fromEntries(STEPS.map((s) => [s, round(totals[s])])),
      series
    },
    dimensions: Object.keys(baseline.scores).map((name) => ({
      name,
      baseline: baseline.scores![name],
      current: state[name]!,
      delta: round(state[name]! - baseline.scores![name]!, 1),
      margin: config.margins[name] ?? 0,
      series: kept(history).map((e) => e.scores![name])
    })),
    rows,
    retro: existsSync(join(dir, "retro.json")) ? JSON.parse(readFileSync(join(dir, "retro.json"), "utf8")) : null
  };
}

/** Renders the ascent's history into report.html in its folder, replacing the previous one, and returns its path. */
export function writeReport(name: string): string {
  const data = JSON.stringify(reportData(loadConfig(name), loadHistory(name))).replaceAll("<", "\\u003c");
  const out = join(ascentDir(name), "report.html");
  writeFileSync(out, readFileSync(TEMPLATE, "utf8").replace(PLACEHOLDER, () => data));
  return out;
}
