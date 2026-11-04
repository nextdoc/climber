import { existsSync, globSync, readFileSync, writeFileSync } from "node:fs";
import { join, posix, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { AscentDefaults, REPO_ROOT } from "./ascent.ts";
import { collected, collectRun, sliceRun } from "./map-run.ts";
import { DIMENSION_NAMES, scoreRun, type HalfScores, type Weights } from "./scoring.ts";

const TEMPLATE = join(REPO_ROOT, "cli/map.html");

const PLACEHOLDER = "/*DATA*/null";

const Dimension = z.enum(DIMENSION_NAMES as [string, ...string[]]);

const ClassName = z.string().regex(/^\w+$/, "an Apex class name");

const Group = z.strictObject({
  /** Set when the group is created and never changed, so renames and moved classes keep the group's score attached. */
  id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "a kebab-case slug"),
  name: z.string().min(1),
  description: z.string().min(1).optional(),
  classes: z.array(ClassName).min(1),
  tests: z.array(ClassName),
  fixtures: z.array(ClassName).default([]),
  headroomTest: z.string().regex(/^\w+\.\w+$/, "Class.method").optional(),
  /** Tagging: one value per facet, such as { "version": "v3" }. */
  tags: z.record(z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "a kebab-case facet"), z.string().min(1)).optional()
});

export type Group = z.infer<typeof Group>;

/** The root is relative to the repo, and the globs to the root. */
const Source = z.strictObject({
  root: z.string().min(1),
  include: z.array(z.string()).min(1),
  ignore: z.array(z.string()).default([])
});

const groupMembers = (g: Group) => [...g.classes, ...g.tests, ...g.fixtures];

export const ProjectMap = z
  .strictObject({
    approved: z.boolean().default(false),
    source: Source.optional(),
    unassigned: z.array(ClassName).default([]),
    groups: z.array(Group).min(1)
  })
  .superRefine((m, ctx) => {
    if (new Set(m.groups.map((g) => g.id)).size !== m.groups.length) ctx.addIssue({ code: "custom", message: "Group ids must be unique" });
    const seen = new Set<string>();
    for (const name of [...m.groups.flatMap(groupMembers), ...m.unassigned]) {
      if (seen.has(name)) ctx.addIssue({ code: "custom", message: `${name} is in two groups, or in a group and unassigned` });
      seen.add(name);
    }
    if (m.approved && m.unassigned.length > 0) ctx.addIssue({ code: "custom", message: "An approved map has no unassigned classes" });
  });

export type ProjectMap = z.infer<typeof ProjectMap>;

const GroupScore = z.strictObject({
  overall: z.number().min(0).max(100),
  dimensions: z.partialRecord(Dimension, z.number()),
  /** Dimensions the group could not be scored on, given weight 0 for it. */
  skipped: z.array(Dimension),
  gate: z.string().optional(),
  classes: z.array(ClassName),
  /** Tests and fixtures. */
  tests: z.array(ClassName),
  run: z.string().min(1),
  scoredAt: z.iso.datetime()
});

export type GroupScore = z.infer<typeof GroupScore>;

/** Scores keyed by group id. */
export const MapScores = z.record(z.string(), GroupScore);

export type MapScores = z.infer<typeof MapScores>;

export const mapDir = (name: string) => join(REPO_ROOT, "target/map", name);

const readJson = (file: string) => JSON.parse(readFileSync(file, "utf8"));

const writeJson = (file: string, value: unknown) => writeFileSync(file, JSON.stringify(value, null, 2) + "\n");

export const loadMap = (file: string): ProjectMap => ProjectMap.parse(readJson(file));

export const saveMap = (file: string, map: ProjectMap) => writeJson(file, ProjectMap.parse(map));

export const loadScores = (file: string): MapScores => (existsSync(file) ? MapScores.parse(readJson(file)) : {});

/** The folder a map's classes are found under: the override, else the map's source root, else the repo. */
export const mapRoot = (map: ProjectMap, override?: string) => resolve(REPO_ROOT, override ?? map.source?.root ?? ".");

/** Apex source without comments or string literals, so neither can mark a test or a reference. */
const code = (source: string) => source.replace(/\/\*[\s\S]*?\*\/|\/\/.*|'(?:\\.|[^'\\])*'/g, " ");

const isTestClass = (source: string) => /@isTest\b/i.test(code(source));

const nonBlankLines = (source: string) => source.split("\n").filter((l) => l.trim()).length;

const className = (path: string) => path.split("/").pop()!.replace(/\.cls$/, "");

export type ApexFile = { name: string; path: string; test: boolean; lines: number; source: string };

const readApex = (root: string, path: string): ApexFile => {
  const source = readFileSync(join(root, path), "utf8");
  return { name: className(path), path, test: isTestClass(source), lines: nonBlankLines(source), source };
};

const SKIPPED_FOLDERS = ["node_modules", "target", ".sf", ".sfdx", ".git"];

/** A path with / separators, where Windows uses \. */
const slashed = (path: string) => path.split(sep).join("/");

const glob = (root: string, patterns: string[]) =>
  new Set(
    patterns.flatMap((p) =>
      globSync(normaliseGlob(p), { cwd: root, exclude: (f) => SKIPPED_FOLDERS.some((s) => slashed(f) === s || slashed(f).startsWith(`${s}/`)) }).map(slashed)
    )
  );

/** The same glob whatever shell passed it: without the single quotes cmd.exe keeps, and with / in place of \. */
export const normaliseGlob = (arg: string) => arg.replace(/^(['"])(.*)\1$/, "$2").replaceAll("\\", "/");

/** Arguments that name an existing file and hold no glob characters, which is what a shell passes after expanding an unquoted glob. */
export const shellExpanded = (root: string, args: string[]) =>
  args.filter((a) => !/[*?[\]{}]/.test(normaliseGlob(a)) && existsSync(join(root, normaliseGlob(a))));

/** Class files the include globs select, less the ones the ignore globs drop, which are returned apart. */
export function selectFiles(root: string, include: string[], ignore: string[]) {
  const ignoredGlob = glob(root, ignore);
  const included = [...glob(root, include)].filter((f) => f.endsWith(".cls")).sort();
  return { selected: included.filter((f) => !ignoredGlob.has(f)), ignored: included.filter((f) => ignoredGlob.has(f)) };
}

/** Every .cls file under root, by class name. */
export function indexClasses(root: string): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const path of [...glob(root, ["**/*.cls"])].sort()) index.set(className(path), [...(index.get(className(path)) ?? []), path]);
  return index;
}

export const slug = (name: string) =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/** Case-sensitive, though Apex is not, so a variable such as `fixtures` is not taken for the class `Fixtures`. */
const refersTo = (file: ApexFile, name: string) => new RegExp(`\\b${name}\\b`).test(code(file.source));

/** Groups the selected classes by name, as doc/mapping.md "Default grouping" describes. */
export function gatherMap(root: string, include: string[], ignore: string[] = []): ProjectMap {
  const files = selectFiles(root, include, ignore).selected.map((p) => readApex(root, p));
  const apps = files.filter((f) => !f.test);
  const appByLower = new Map(apps.map((a) => [a.name.toLowerCase(), a.name]));
  const groups = new Map<string, Group>(apps.map((a) => [a.name, { id: slug(a.name), name: a.name, classes: [a.name], tests: [], fixtures: [] }]));
  const ownerOfTest = new Map<string, string>();
  const unassigned: string[] = [];
  for (const t of files.filter((f) => f.test)) {
    const owner = [t.name.replace(/_?test$/i, ""), t.name.replace(/^test_?/i, "")].map((n) => appByLower.get(n.toLowerCase())).find(Boolean);
    if (owner) {
      ownerOfTest.set(t.name, owner);
      groups.get(owner)!.tests.push(t.name);
    } else unassigned.push(t.name);
  }
  // An app class a test is named after is never a fixture, even when only tests refer to it.
  const tested = new Set(ownerOfTest.values());
  for (const app of apps.filter((a) => !tested.has(a.name))) {
    const referrers = files.filter((f) => f !== app && refersTo(f, app.name));
    if (referrers.length === 0 || referrers.some((f) => !f.test)) continue;
    const owners = new Set(referrers.map((f) => ownerOfTest.get(f.name)));
    groups.delete(app.name);
    const [owner] = owners;
    if (owners.size === 1 && owner) groups.get(owner)!.fixtures.push(app.name);
    else unassigned.push(app.name);
  }
  if (groups.size === 0) throw new Error("The globs select no app classes");
  return ProjectMap.parse({
    source: { root: slashed(relative(REPO_ROOT, root)) || ".", include: include.map(normaliseGlob), ignore: ignore.map(normaliseGlob) },
    unassigned: unassigned.sort(),
    groups: [...groups.values()].sort((a, b) => a.id.localeCompare(b.id))
  });
}

/** Problems that stop the map being rendered or scored: classes that are missing or found more than once under root. */
export function checkMap(map: ProjectMap, root: string): string[] {
  const index = indexClasses(root);
  return [...map.groups.flatMap(groupMembers), ...map.unassigned].flatMap((name) => {
    const found = index.get(name) ?? [];
    return found.length === 1 ? [] : [`Expected one ${name}.cls under ${root}, found ${found.length}`];
  });
}

/** Throws with every problem checkMap finds. */
export function assertMap(map: ProjectMap, root: string) {
  const errors = checkMap(map, root);
  if (errors.length > 0) throw new Error(errors.join("\n"));
}

export type Unmapped = { name: string; path: string; kind: "app" | "test"; lines: number; reason: "unassigned" | "ignored" | "not in map" };

/** Classes in no group: from the map's source globs, and from every folder that holds a mapped class. */
export function unmappedClasses(map: ProjectMap, root: string): Unmapped[] {
  const index = indexClasses(root);
  const mapped = new Set(map.groups.flatMap(groupMembers));
  const unassigned = new Set(map.unassigned);
  const reasons = new Map<string, Unmapped["reason"]>();
  const add = (path: string, reason: Unmapped["reason"]) => {
    if (!mapped.has(className(path)) && !reasons.has(path)) reasons.set(path, unassigned.has(className(path)) ? "unassigned" : reason);
  };
  if (map.source) {
    const { selected, ignored } = selectFiles(root, map.source.include, map.source.ignore);
    selected.forEach((p) => add(p, "not in map"));
    ignored.forEach((p) => add(p, "ignored"));
  }
  const folders = new Set([...mapped].flatMap((n) => (index.get(n) ?? []).map(posix.dirname)));
  for (const paths of index.values()) paths.filter((p) => folders.has(posix.dirname(p))).forEach((p) => add(p, "not in map"));
  for (const name of unassigned) (index.get(name) ?? []).forEach((p) => add(p, "unassigned"));
  return [...reasons]
    .map(([path, reason]) => {
      const file = readApex(root, path);
      return { name: file.name, path, kind: file.test ? ("test" as const) : ("app" as const), lines: file.lines, reason };
    })
    .sort((a, b) => b.lines - a.lines || a.name.localeCompare(b.name));
}

const pathOf = (index: Map<string, string[]>, name: string) => index.get(name)![0];

/** Non-blank lines of a group's classes, and of its tests with fixtures. */
export function groupLines(group: Group, root: string, index = indexClasses(root)) {
  const count = (names: string[]) => names.reduce((n, name) => n + readApex(root, pathOf(index, name)).lines, 0);
  return { classes: count(group.classes), tests: count([...group.tests, ...group.fixtures]) };
}

const sameMembers = (a: string[], b: string[]) => [...a].sort().join() === [...b].sort().join();

/** Groups whose classes or tests differ from the ones they were scored with. */
export const changedSinceScored = (map: ProjectMap, scores: MapScores) =>
  map.groups.filter((g) => scores[g.id] && !(sameMembers(scores[g.id].classes, g.classes) && sameMembers(scores[g.id].tests, [...g.tests, ...g.fixtures])));

/** Renders the map as a treemap page at out, coloured by scores when given, and returns out. */
export function writeMapPage(map: ProjectMap, root: string, mapFile: string, out: string, scores?: MapScores): string {
  assertMap(map, root);
  const index = indexClasses(root);
  const changed = new Set((scores ? changedSinceScored(map, scores) : []).map((g) => g.id));
  const groups = map.groups.map((g) => ({ ...g, lines: groupLines(g, root, index), score: scores?.[g.id], changed: changed.has(g.id) }));
  const data = JSON.stringify({ source: relative(REPO_ROOT, mapFile), approved: map.approved, scored: scores !== undefined, groups, unmapped: unmappedClasses(map, root) });
  writeFileSync(out, readFileSync(TEMPLATE, "utf8").replace(PLACEHOLDER, () => data.replaceAll("<", "\\u003c")));
  return out;
}

const TEST_DIMENSIONS = ["Tests passing", "Code coverage", "Test run time", "Limit headroom", "Resource efficiency"];

/** The ascent defaults' weights, with weight 0 for each dimension the group cannot be scored on. */
export function groupWeights(group: Group, defaults: Weights): { weights: Weights; skipped: string[] } {
  const skipped = group.tests.length === 0 ? TEST_DIMENSIONS : group.headroomTest ? [] : ["Limit headroom"];
  return { weights: { ...defaults, ...Object.fromEntries(skipped.map((d) => [d, 0])) }, skipped: skipped.filter((d) => (defaults[d] ?? 1) > 0) };
}

/** Scores a group from its slice of the map's run, like an ascent baseline, without deploying. */
function scoreGroup(group: Group, root: string, folder: string, defaults: Weights, halfScores: HalfScores, index: Map<string, string[]>): GroupScore {
  const { weights, skipped } = groupWeights(group, defaults);
  const app = group.classes.map((n) => pathOf(index, n));
  const test = [...group.tests, ...group.fixtures].map((n) => pathOf(index, n));
  const score = scoreRun({ app, test, run: folder, root, weights, halfScores, skipDeploy: true, headroomTest: group.headroomTest ? [group.headroomTest] : [] });
  return GroupScore.parse({
    overall: score.overall,
    dimensions: Object.fromEntries((score.dimensions ?? []).map((d) => [d.name, d.score])),
    skipped,
    gate: score.gate,
    classes: group.classes,
    tests: [...group.tests, ...group.fixtures],
    run: slashed(relative(REPO_ROOT, folder)),
    scoredAt: new Date().toISOString()
  });
}

/** Collects the map's run unless one already covers it, or fresh is set, then slices it and scores every group. */
export async function scoreMap(map: ProjectMap, root: string, org: string, dir: string, fresh = false, log = console.error): Promise<MapScores> {
  if (!map.approved) throw new Error('The map is not approved. Review before.html, then set "approved": true in the map file.');
  assertMap(map, root);
  const index = indexClasses(root);
  const { weights, halfScores } = AscentDefaults.parse(readJson(join(REPO_ROOT, "ascent.config.json")));
  const off = (...names: string[]) => names.every((n) => weights[n] === 0);
  const tests = map.groups.flatMap((g) => g.tests).sort();
  const skipTests = tests.length === 0 || off(...TEST_DIMENSIONS);
  const collection = {
    tests,
    targets: map.groups.flatMap((g) => g.classes.map((n) => pathOf(index, n))).sort(),
    skip: { pmd: off("PMD"), sfge: off("Graph Engine"), tests: skipTests, logs: skipTests || off("Limit headroom", "Resource efficiency") }
  };
  const runDir = join(dir, "run");
  if (fresh || !collected(runDir, collection)) await collectRun(org, root, runDir, collection, log);
  else log(`Reusing ${runDir}`);
  sliceRun(runDir, root, map.groups.map((g) => ({ id: g.id, tests: g.tests, app: g.classes.map((n) => pathOf(index, n)) })), join(dir, "runs"));
  const scores = MapScores.parse(Object.fromEntries(map.groups.map((g) => [g.id, scoreGroup(g, root, join(dir, "runs", g.id), weights, halfScores, index)])));
  writeJson(join(dir, "scores.json"), scores);
  return scores;
}
