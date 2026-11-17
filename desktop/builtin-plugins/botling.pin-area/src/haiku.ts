// botling.pin-area, the one model call: the line classifier asks `claude -p` (the CLI as Botling starts it, `engines.cli`) with no tools, no MCP, no
// settings and no session kept, the question on stdin, as the chat summaries' one-shot call does (botling.catchup). The pure part is classify.ts.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLASSIFIER_MODEL, SCHEMA, SYSTEM } from "./classify";

/** The send waits for this call: no answer in time is no answer (the line goes to the chat as it is). */
export const CLASSIFY_TIMEOUT_MS = 8_000;
/** The CLI as `api.engines.cli` gives it. */
export interface Cli { file: string; args: string[]; env: Record<string, string> }
/** One question to the classifier model; resolves to what it answered (an object or its text), rejects on any failure. */
export type Ask = (prompt: string) => Promise<unknown>;

/** The isolated call: no tools (`--tools ""`), no MCP, no slash commands, no settings, nothing kept; the answer held to the schema. */
export function haikuArguments(): string[] {
  return ["-p", "--output-format", "json", "--model", CLASSIFIER_MODEL, "--tools", "", "--strict-mcp-config", "--no-session-persistence",
    "--disable-slash-commands", "--setting-sources", "", "--system-prompt", SYSTEM, "--json-schema", SCHEMA];
}

/** What claude's `--output-format json` result holds: the structured answer, else its text. Throws when the call failed or said nothing. */
export function resultOf(output: string): unknown {
  const value = JSON.parse(output) as { is_error?: unknown; structured_output?: unknown; result?: unknown };
  if (!value || typeof value !== "object" || value.is_error === true) throw new Error("failed");
  if (value.structured_output && typeof value.structured_output === "object") return value.structured_output;
  if (typeof value.result !== "string") throw new Error("no result");
  return value.result;
}

/** The environment of the child: the host's, without a parent Claude's markers, `extra` (the CLI's own) added. */
function environment(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  for (const key of ["CLAUDECODE", "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN", "CLAUDE_CODE_ENTRYPOINT", "ELECTRON_RUN_AS_NODE", "CCB_PLUGIN_HOST"]) delete env[key];
  return { ...env, ...extra };
}

/** Asks the model once through `cli`, in a fresh temporary folder (removed after); ends the child's whole group on a timeout. */
export function askHaiku(cli: Cli, prompt: string, timeoutMs = CLASSIFY_TIMEOUT_MS): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const folder = mkdtempSync(join(tmpdir(), "botling-pin-"));
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = (error: Error | null, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rmSync(folder, { recursive: true, force: true });
      if (error) reject(error); else resolve(value);
    };
    let child: ReturnType<typeof spawn>;
    try { child = spawn(cli.file, [...cli.args, ...haikuArguments()], { cwd: folder, env: environment(cli.env), stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" }); } catch { done(new Error("spawn")); return; }
    const kill = () => {
      try { if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* gone */ } }
    };
    let output = "";
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => { if (output.length < 1_000_000) output += chunk; });
    child.stderr!.resume();
    child.stdin!.on("error", () => { /* it exited first; close reports */ });
    child.stdin!.end(prompt);
    timer = setTimeout(() => { kill(); done(new Error("timeout")); }, timeoutMs);
    child.once("error", () => done(new Error("spawn")));
    child.once("close", (code) => {
      if (code !== 0) return done(new Error("exit"));
      try { done(null, resultOf(output)); } catch { done(new Error("answer")); }
    });
  });
}
