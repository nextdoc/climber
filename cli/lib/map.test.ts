import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { changedSinceScored, checkMap, gatherMap, groupLines, groupWeights, normaliseGlob, ProjectMap, shellExpanded, slug, unmappedClasses, type GroupScore } from "./map.ts";

const group = (id: string, classes = ["A"], tests = ["ATest"]) => ({ id, name: id, classes, tests });

/** A temporary root with the given class files under classes/, or under the path when the name has a slash. */
function root(files: Record<string, string>) {
  mkdirSync(join(process.cwd(), "target/tmp"), { recursive: true });
  const dir = mkdtempSync(join(process.cwd(), "target/tmp/map-"));
  for (const [name, source] of Object.entries(files)) {
    const path = join(dir, name.includes("/") ? name : `classes/${name}`);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, source);
  }
  return dir;
}

const testClass = (body = "") => `@isTest\nprivate class T {\n${body}\n}\n`;

describe("ProjectMap", () => {
  test("rejects duplicate group ids", () => {
    expect(ProjectMap.safeParse({ groups: [group("a"), group("a", ["B"], [])] }).success).toBe(false);
  });

  test("requires kebab-case ids and leaves description optional", () => {
    expect(ProjectMap.safeParse({ groups: [group("Account Health")] }).success).toBe(false);
    expect(ProjectMap.parse({ groups: [group("account-health")] }).approved).toBe(false);
  });

  test("rejects a class in two groups or in a group and unassigned", () => {
    expect(ProjectMap.safeParse({ groups: [group("a"), group("b", ["B"])] }).success).toBe(false);
    expect(ProjectMap.safeParse({ groups: [group("a")], unassigned: ["A"] }).success).toBe(false);
  });

  test("rejects an approved map with unassigned classes", () => {
    expect(ProjectMap.safeParse({ approved: true, groups: [group("a")], unassigned: ["X"] }).success).toBe(false);
  });
});

test("slug turns a class name into kebab case", () => {
  expect(slug("AccountHealthRollup")).toBe("account-health-rollup");
  expect(slug("HTTPCallout_Service")).toBe("http-callout-service");
});

describe("gatherMap", () => {
  const sample = () =>
    root({
      "Foo.cls": "public class Foo {}",
      "FooTest.cls": testClass("Foo f; FooFixtures x; Shared s;"),
      "Test_Bar.cls": testClass("Bar b; Shared s; Integer foofixtures;"),
      "Bar.cls": "public class Bar {}",
      "Baz.cls": "// not @isTest\npublic class Baz { Foo f; }",
      "FooFixtures.cls": "// not @isTest\npublic class FooFixtures {}",
      "Shared.cls": "public class Shared {}",
      "Orphan_Test.cls": testClass(),
      "Mock.cls": "public class Mock {}"
    });

  test("groups tests by name, moves one group's fixtures in, and leaves the rest unassigned", () => {
    const dir = sample();
    const map = gatherMap(dir, ["classes/*.cls"], ["**/Mock.cls"]);
    expect(map.groups).toEqual([
      { id: "bar", name: "Bar", classes: ["Bar"], tests: ["Test_Bar"], fixtures: [] },
      { id: "baz", name: "Baz", classes: ["Baz"], tests: [], fixtures: [] },
      { id: "foo", name: "Foo", classes: ["Foo"], tests: ["FooTest"], fixtures: ["FooFixtures"] }
    ]);
    expect(map.unassigned).toEqual(["Orphan_Test", "Shared"]);
    expect(map.source).toEqual({ root: expect.any(String), include: ["classes/*.cls"], ignore: ["**/Mock.cls"] });
  });

  // The arguments each shell hands the CLI for one include glob and one ignore glob.
  test.each([
    ["bash, zsh or PowerShell, quoted, or cmd.exe double-quoted", ["classes/*.cls"], ["**/Mock.cls"]],
    ["cmd.exe single-quoted, which keeps the quotes", ["'classes/*.cls'"], ["'**/Mock.cls'"]],
    ["Windows backslashes", ["classes\\*.cls"], ["**\\Mock.cls"]]
  ])("records the same globs and groups from %s", (_, include, ignore) => {
    const map = gatherMap(sample(), include, ignore);
    expect(map.groups.map((g) => g.id)).toEqual(["bar", "baz", "foo"]);
    expect(map.source).toMatchObject({ include: ["classes/*.cls"], ignore: ["**/Mock.cls"] });
  });

  test("gathers the same groups from the files a shell expanded an unquoted glob to", () => {
    const dir = sample();
    const files = ["Foo", "FooTest", "Test_Bar", "Bar", "Baz", "FooFixtures", "Shared", "Orphan_Test"].map((n) => `classes/${n}.cls`);
    expect(gatherMap(dir, files).groups).toEqual(gatherMap(dir, ["classes/*.cls"], ["**/Mock.cls"]).groups);
  });

  test("ignores @isTest in a comment", () => {
    const map = gatherMap(sample(), ["classes/*.cls"]);
    expect(map.groups.map((g) => g.id)).toContain("baz");
  });
});

test("normaliseGlob drops one pair of wrapping quotes and turns backslashes into slashes", () => {
  expect(normaliseGlob("'force-app/**/*.cls'")).toBe("force-app/**/*.cls");
  expect(normaliseGlob('"force-app/**/*.cls"')).toBe("force-app/**/*.cls");
  expect(normaliseGlob("force-app\\**\\*.cls")).toBe("force-app/**/*.cls");
  expect(normaliseGlob("'a.cls\"")).toBe("'a.cls\"");
});

test("shellExpanded finds arguments that name existing files and hold no glob characters", () => {
  const dir = root({ "A.cls": "a" });
  expect(shellExpanded(dir, ["classes/A.cls", "'classes/A.cls'", "classes/*.cls", "classes/Missing.cls"])).toEqual(["classes/A.cls", "'classes/A.cls'"]);
});

describe("checkMap", () => {
  test("reports missing and duplicate classes", () => {
    const dir = root({ "A.cls": "a", "ATest.cls": "t", "a/classes/X.cls": "x", "b/classes/X.cls": "x" });
    expect(checkMap(ProjectMap.parse({ groups: [group("a")] }), dir)).toEqual([]);
    expect(checkMap(ProjectMap.parse({ groups: [group("a", ["A", "Missing"])], unassigned: ["X"] }), dir)).toEqual([
      `Expected one Missing.cls under ${dir}, found 0`,
      `Expected one X.cls under ${dir}, found 2`
    ]);
  });
});

test("groupLines counts non-blank lines, with fixtures in the test lines", () => {
  const dir = root({ "A.cls": "a\n\nb\n", "ATest.cls": "t\n", "F.cls": "f\n  \nf\n" });
  expect(groupLines({ ...group("a"), fixtures: ["F"] }, dir)).toEqual({ classes: 2, tests: 3 });
});

describe("unmappedClasses", () => {
  test("lists unassigned, ignored and unlisted classes from the globs and mapped folders", () => {
    const dir = root({ "A.cls": "a", "ATest.cls": testClass(), "U.cls": "u", "Ig.cls": "i\ni", "New.cls": testClass(), "other/Far.cls": "f" });
    const map = ProjectMap.parse({ source: { root: ".", include: ["classes/*.cls"], ignore: ["**/Ig.cls"] }, unassigned: ["U"], groups: [group("a")] });
    expect(unmappedClasses(map, dir)).toEqual([
      { name: "New", path: "classes/New.cls", kind: "test", lines: 3, reason: "not in map" },
      { name: "Ig", path: "classes/Ig.cls", kind: "app", lines: 2, reason: "ignored" },
      { name: "U", path: "classes/U.cls", kind: "app", lines: 1, reason: "unassigned" }
    ]);
  });

  test("finds unlisted classes beside mapped ones in a map without a source", () => {
    const dir = root({ "A.cls": "a", "ATest.cls": "t", "B.cls": "b" });
    expect(unmappedClasses(ProjectMap.parse({ groups: [group("a")] }), dir).map((u) => u.name)).toEqual(["B"]);
  });
});

test("groupWeights gives weight 0 to limit headroom without a headroom test, and to every test dimension without tests", () => {
  const defaults = { "Graph Engine": 0 };
  expect(groupWeights({ ...group("a"), fixtures: [] }, defaults)).toEqual({ weights: { "Graph Engine": 0, "Limit headroom": 0 }, skipped: ["Limit headroom"] });
  expect(groupWeights({ ...group("a"), fixtures: [], headroomTest: "ATest.h" }, defaults).skipped).toEqual([]);
  expect(groupWeights({ ...group("a", ["A"], []), fixtures: [] }, defaults).skipped).toHaveLength(5);
});

test("changedSinceScored finds groups whose classes or tests differ from the scored ones", () => {
  const map = ProjectMap.parse({ groups: [{ ...group("a"), fixtures: ["F"] }, group("b", ["B"], ["BTest"])] });
  const score = (classes: string[], tests: string[]): GroupScore => ({ overall: 50, dimensions: {}, skipped: [], classes, tests, run: "r", scoredAt: new Date().toISOString() });
  expect(changedSinceScored(map, { a: score(["A"], ["F", "ATest"]), b: score(["B"], ["BTest", "Old"]) }).map((g) => g.id)).toEqual(["b"]);
});
