import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./lib/ascent.ts";
import { gatherMap, mapDir } from "./lib/map.ts";

const INCLUDE = "force-app/**/classes/*.cls";
const IGNORE = "**/ContactEmail*.cls";
const expected = gatherMap(REPO_ROOT, [INCLUDE], [IGNORE]);
const names: string[] = [];

type Case = { name: string; shell: string; include: string; ignore: string; expanded: boolean };

/** Runs `map gather` the way a user types it into the shell, so the shell's own quoting and glob expansion apply. */
function gather(c: Case) {
  const name = `shell-${c.name.replace(/\W+/g, "-")}`;
  names.push(name);
  const command = `bun cli/map.ts gather ${name} ${c.include} -i ${c.ignore}`;
  const args: Record<string, [string, string[], object?]> = {
    bash: ["bash", ["-c", command]],
    "bash with globstar": ["bash", ["-O", "globstar", "-c", command]],
    zsh: ["zsh", ["-c", command]],
    "cmd.exe": ["cmd.exe", ["/d", "/s", "/c", `"${command}"`], { windowsVerbatimArguments: true }],
    PowerShell: ["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command]]
  };
  const [file, argv, options] = args[c.shell];
  const result = spawnSync(file, argv, { cwd: REPO_ROOT, encoding: "utf8", ...options });
  if (result.status !== 0) throw new Error(`${c.name} exited ${result.status}:\n${result.stdout}\n${result.stderr}`);
  return { map: JSON.parse(readFileSync(join(mapDir(name), "map.json"), "utf8")), stderr: result.stderr };
}

const quoted = (q: string) => ({ include: `${q}${INCLUDE}${q}`, ignore: `${q}${IGNORE}${q}` });
const unquoted = { include: INCLUDE, ignore: IGNORE };

const UNIX: Case[] = [
  { name: "bash quoted", shell: "bash", ...quoted("'"), expanded: false },
  // Without globstar, ** acts as *, matches nothing here, and bash passes the glob on unchanged.
  { name: "bash unquoted", shell: "bash", ...unquoted, expanded: false },
  { name: "bash globstar quoted", shell: "bash with globstar", ...quoted("'"), expanded: false },
  { name: "bash globstar unquoted", shell: "bash with globstar", ...unquoted, expanded: true },
  { name: "zsh quoted", shell: "zsh", ...quoted("'"), expanded: false },
  { name: "zsh unquoted", shell: "zsh", ...unquoted, expanded: true }
];

const WINDOWS: Case[] = [
  { name: "cmd double-quoted", shell: "cmd.exe", ...quoted('"'), expanded: false },
  { name: "cmd single-quoted", shell: "cmd.exe", ...quoted("'"), expanded: false },
  { name: "cmd unquoted", shell: "cmd.exe", ...unquoted, expanded: false },
  { name: "cmd backslashes", shell: "cmd.exe", include: INCLUDE.replaceAll("/", "\\"), ignore: IGNORE.replaceAll("/", "\\"), expanded: false },
  { name: "PowerShell single-quoted", shell: "PowerShell", ...quoted("'"), expanded: false },
  { name: "PowerShell double-quoted", shell: "PowerShell", ...quoted('"'), expanded: false },
  { name: "PowerShell unquoted", shell: "PowerShell", ...unquoted, expanded: false }
];

// macOS ships bash 3.2, which has no globstar.
const available = (c: Case) =>
  Bun.which(c.shell.split(" ")[0]) !== null && (c.shell !== "bash with globstar" || spawnSync("bash", ["-O", "globstar", "-c", "true"]).status === 0);

afterAll(() => names.forEach((n) => rmSync(mapDir(n), { recursive: true, force: true })));

describe("map gather from each shell", () => {
  const cases = (process.platform === "win32" ? WINDOWS : UNIX).filter(available);

  test.each(cases.map((c) => [c.name, c] as const))("%s gathers the same groups", (_, c) => {
    const { map, stderr } = gather(c);
    expect(map.groups).toEqual(expected.groups);
    if (c.expanded) {
      expect(stderr).toContain("Warning: file paths, not globs");
      expect(map.source.include).not.toContain(INCLUDE);
    } else {
      expect(stderr).toBe("");
      expect(map.source).toMatchObject({ include: [INCLUDE], ignore: [IGNORE] });
    }
  }, 30_000);
});
