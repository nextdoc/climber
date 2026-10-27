import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./ascent.ts";
import { compose } from "./compose.ts";

const DIR = join(REPO_ROOT, "target/tmp/compose-test");

test("composes one script per variant from the extracted classes, the scenarios and the variant statement", () => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(join(DIR, "classes"), { recursive: true });
  writeFileSync(join(DIR, "classes/Greeter.cls"), "public class Greeter {\n  public static String hi() { return 'hi'; }\n}\n");
  writeFileSync(join(DIR, "Scenarios.apex"), "class Scenarios { void run() { System.debug(new Greeter().hi()); } }\n");
  const files = compose(DIR, DIR, {
    classes: ["classes/*.cls"],
    scenarios: "Scenarios.apex",
    variants: { one: "new Scenarios().run();", two: "System.debug(1);" },
    runCounts: {}
  });
  expect(files).toEqual([join(DIR, "one.apex"), join(DIR, "two.apex")]);
  const script = readFileSync(join(DIR, "one.apex"), "utf8");
  expect(script).toStartWith("// === CLASSES ===\n");
  expect(script).toContain("public class Greeter");
  expect(script).toContain("class Scenarios");
  expect(script).toEndWith("// === CODE ===\n\nnew Scenarios().run();\n");
});
