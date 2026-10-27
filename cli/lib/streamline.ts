import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/** What streamline.json records per variant. An uncaught exception has success false with compiled true. */
export type VariantResult = {
  variant: string;
  compiled: boolean;
  success: boolean;
  compileProblem: string | null;
  exception: { type: string; message: string } | null;
  executionMs: number;
};

type ServerConfig = { command: string; args?: string[]; env?: Record<string, string> };

async function call<T>(client: Client, name: string, args: Record<string, unknown>): Promise<T> {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as { type: string; text?: string }[]).find((c) => c.type === "text")?.text ?? "";
  if (result.isError) throw new Error(`${name} failed: ${text}`);
  return JSON.parse(text) as T;
}

/**
 * Runs <folder>/<variant>.apex for each variant with the Streamline server from the MCP config, rolling back each one.
 * Writes logs/<variant>.log and streamline.json into the folder, the inputs scoreRun reads in streamline mode.
 */
export async function runVariants(mcpConfig: string, org: string, folder: string, variants: string[]): Promise<VariantResult[]> {
  const server: ServerConfig = JSON.parse(readFileSync(mcpConfig, "utf8")).mcpServers.streamline;
  const dir = resolve(folder);
  const transport = new StdioClientTransport({
    command: server.command,
    args: server.args,
    // The web UI is off so the server does not clash with another Streamline instance on its port.
    env: { ...(process.env as Record<string, string>), ...server.env, ALLOWED_DIRS: dir, ENABLE_WEB_UI: "false" },
    stderr: "pipe"
  });
  const serverLog: string[] = [];
  transport.stderr?.on("data", (chunk) => serverLog.push(String(chunk)));
  const client = new Client({ name: "climb-your-apex", version: "1.0.0" });
  await client.connect(transport);
  const loadToken = async () => {
    const token = await call<{ success: boolean; error?: string }>(client, "loadAccessToken", { orgAlias: org });
    if (!token.success) throw new Error(`loadAccessToken failed for ${org}: ${token.error}`);
  };
  const runFile = (variant: string) =>
    call<VariantResult>(client, "runFileAndRollback", { filePath: join(dir, `${variant}.apex`), orgAlias: org });
  try {
    await loadToken();
    mkdirSync(join(dir, "logs"), { recursive: true });
    const results: VariantResult[] = [];
    for (const variant of variants) {
      let result: VariantResult;
      try {
        result = await runFile(variant);
      } catch (error) {
        if (!/401|INVALID_SESSION/.test((error as Error).message)) throw error;
        await loadToken();
        result = await runFile(variant);
      }
      const { compiled, success, compileProblem, exception, executionMs } = result;
      results.push({ variant, compiled, success, compileProblem, exception, executionMs });
      const log = await call<{ success: boolean; filePath?: string }>(client, "writeDebugLogToFile", {});
      if (log.success && log.filePath) {
        copyFileSync(log.filePath, join(dir, "logs", `${variant}.log`));
        rmSync(log.filePath);
      }
    }
    writeFileSync(join(dir, "streamline.json"), JSON.stringify(results, null, 2) + "\n");
    return results;
  } finally {
    await client.close();
    writeFileSync(join(dir, "streamline-server.log"), serverLog.join(""));
  }
}
