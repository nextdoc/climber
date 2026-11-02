import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { Command } from "commander";
import {
  changedSinceScored,
  checkMap,
  gatherMap,
  loadMap,
  loadScores,
  mapDir,
  mapRoot,
  saveMap,
  shellExpanded,
  scoreMap,
  writeMapPage
} from "./lib/map.ts";

const program = new Command().name("map").description("Chart the Apex codebase as a treemap of groups of classes and tests (doc/mapping.md)");

const mapFile = (name: string, file?: string) => resolve(file ?? join(mapDir(name), "map.json"));

program
  .command("gather")
  .description("Select class files with globs and group them by name into the map's map.json")
  .argument("<name>", "the map's name, which names its folder under target/map")
  .argument("<globs...>", "include globs, relative to the root")
  .option("-i, --ignore <globs...>", "globs of files to leave out", [])
  .option("--root <dir>", "folder the globs are relative to", ".")
  .action((name: string, include: string[], opts: { ignore: string[]; root: string }) => {
    const root = resolve(opts.root);
    const expanded = shellExpanded(root, [...include, ...opts.ignore]);
    if (expanded.length > 0) {
      console.error(`Warning: file paths, not globs, in ${expanded.length} of the arguments. The shell expanded an unquoted glob, so the map records the files it found.`);
      console.error("Quote each glob so the map records it: 'single quotes' in bash, zsh and PowerShell, \"double quotes\" in cmd.exe.");
    }
    const map = gatherMap(root, include, opts.ignore);
    mkdirSync(mapDir(name), { recursive: true });
    saveMap(mapFile(name), map);
    console.log(`${mapFile(name)}: ${map.groups.length} groups, ${map.unassigned.length} unassigned`);
  });

program
  .command("check")
  .description("Validate the map and check that each class it names exists once under the root")
  .argument("<name>", "the map's name")
  .option("--map <file>", "read the map from this file instead of the map's folder")
  .option("--root <dir>", "folder to find the class files under, instead of the map's source root")
  .action((name: string, opts: { map?: string; root?: string }) => {
    const map = loadMap(mapFile(name, opts.map));
    const errors = checkMap(map, mapRoot(map, opts.root));
    errors.forEach((e) => console.error(e));
    if (errors.length > 0) process.exit(1);
    console.log(`OK: ${map.groups.length} groups, ${map.unassigned.length} unassigned`);
  });

program
  .command("render")
  .description("Write the treemap page: before.html sized by lines, or after.html also coloured by score")
  .argument("<name>", "the map's name")
  .option("--scores", "colour the groups by the map's scores.json and write after.html")
  .option("--map <file>", "read the map from this file instead of the map's folder")
  .option("--root <dir>", "folder to find the class files under, instead of the map's source root")
  .action((name: string, opts: { scores?: boolean; map?: string; root?: string }) => {
    const file = mapFile(name, opts.map);
    const map = loadMap(file);
    const scores = opts.scores ? loadScores(join(mapDir(name), "scores.json")) : undefined;
    for (const g of scores ? changedSinceScored(map, scores) : []) console.error(`Warning: ${g.id} has changed classes or tests since it was scored`);
    mkdirSync(mapDir(name), { recursive: true });
    console.log(writeMapPage(map, mapRoot(map, opts.root), file, join(mapDir(name), opts.scores ? "after.html" : "before.html"), scores));
  });

program
  .command("score")
  .description("Score each group with the tests already in the org, largest first, into scores.json; resumes where it stopped")
  .argument("<name>", "the map's name")
  .requiredOption("-o, --org <org>", "target org alias or username")
  .option("--map <file>", "read the map from this file instead of the map's folder")
  .option("--root <dir>", "folder to find the class files under, instead of the map's source root")
  .action((name: string, opts: { org: string; map?: string; root?: string }) => {
    const map = loadMap(mapFile(name, opts.map));
    console.log(JSON.stringify(scoreMap(map, mapRoot(map, opts.root), opts.org, mapDir(name)), null, 2));
  });

program.parse();
