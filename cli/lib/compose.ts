import { globSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StreamlineSuite } from "./ascent.ts";
import { extract, stripComments } from "./extract.ts";

/** Writes <folder>/<variant>.apex per variant: the extracted classes and the scenarios, then the variant statement. */
export function compose(root: string, folder: string, streamline: StreamlineSuite): string[] {
  const files = [...new Set(streamline.classes.flatMap((p) => globSync(p, { cwd: root })))].sort();
  if (files.length === 0) throw new Error(`No classes match ${streamline.classes.join(", ")}`);
  const classes = files.map((f) => stripComments(extract(f, readFileSync(join(root, f), "utf8")).code));
  const scenarios = stripComments(readFileSync(join(root, streamline.scenarios), "utf8"));
  const reminder = "// Composed with comments, indentation and blank lines stripped. Edit the .cls files, not this script.";
  return Object.entries(streamline.variants).map(([variant, statement]) => {
    const file = join(folder, `${variant}.apex`);
    writeFileSync(file, `// === CLASSES ===\n${reminder}\n${classes.join("\n")}\n${scenarios}\n// === CODE ===\n\n${statement}\n`);
    return file;
  });
}
