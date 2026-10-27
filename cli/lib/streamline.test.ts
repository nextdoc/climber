import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./ascent.ts";
import { runVariants } from "./streamline.ts";

const DIR = join(REPO_ROOT, "target/tmp/streamline-test");

// Answers like Streamline: a variant whose script contains "throw" fails with an exception, and the log names the variant's file.
const FAKE_SERVER = `
import { writeFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "node:fs";

let last = "";
const reply = (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const server = new Server({ name: "fake-streamline", version: "1" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
server.setRequestHandler(CallToolRequestSchema, async ({ params: { name, arguments: args } }) => {
  writeFileSync(process.env.CALLS, JSON.stringify({ name, args, allowedDirs: process.env.ALLOWED_DIRS, webUi: process.env.ENABLE_WEB_UI }) + "\\n", { flag: "a" });
  if (name === "loadAccessToken") return reply({ success: true });
  if (name === "runFileAndRollback") {
    last = args.filePath;
    const failed = readFileSync(args.filePath, "utf8").includes("throw");
    return reply({ compiled: true, success: !failed, compileProblem: null, exception: failed ? { type: "E", message: "m" } : null, executionMs: 5, wrappedCode: "" });
  }
  const filePath = process.env.CALLS + ".log";
  writeFileSync(filePath, "1\\tran " + last);
  return reply({ success: true, filePath });
});
await server.connect(new StdioServerTransport());
`;

test("runs each variant, then writes its log and streamline.json into the run folder", async () => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  const calls = join(DIR, "calls.jsonl");
  writeFileSync(join(DIR, "server.ts"), FAKE_SERVER);
  writeFileSync(
    join(DIR, "mcp.json"),
    JSON.stringify({ mcpServers: { streamline: { command: "bun", args: [join(DIR, "server.ts")], env: { CALLS: calls, ALLOWED_DIRS: "./x" } } } })
  );
  const run = join(DIR, "run");
  mkdirSync(run);
  writeFileSync(join(run, "ok.apex"), "System.debug(1);");
  writeFileSync(join(run, "bad.apex"), "throw new E();");

  const results = await runVariants(join(DIR, "mcp.json"), "org", run, ["ok", "bad"]);

  expect(results.map((r) => [r.variant, r.success])).toEqual([["ok", true], ["bad", false]]);
  expect(JSON.parse(readFileSync(join(run, "streamline.json"), "utf8"))).toEqual(results);
  expect(readFileSync(join(run, "logs/bad.log"), "utf8")).toBe(`1\tran ${join(run, "bad.apex")}`);
  expect(existsSync(`${calls}.log`)).toBe(false);
  const sent = readFileSync(calls, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  expect(sent.map((c) => c.name)).toEqual(["loadAccessToken", "runFileAndRollback", "writeDebugLogToFile", "runFileAndRollback", "writeDebugLogToFile"]);
  expect(sent.every((c) => c.allowedDirs === run && c.webUi === "false")).toBe(true);
  expect(sent.filter((c) => c.args.orgAlias !== undefined).every((c) => c.args.orgAlias === "org")).toBe(true);
}, 30_000);
