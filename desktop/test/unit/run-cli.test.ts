// `botling run` (src/cli/run.ts): its arguments, the core's environment, and one whole run on the built core with the
// fake claude: the head hands work to an app-managed worker, the worker reports, and the trajectory lands in --out.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EXIT_ERROR, EXIT_OK, EXIT_TIMEOUT, claudeTranscripts, coreEnvironment, parseArgs, run, runSettings } from "../../src/cli/run";
import { desktop, fakeCli, tempDir } from "../helpers";

const coreScript = join(desktop, "out", "core", "main.cjs");

describe("botling run: arguments and environment", () => {
  it("reads the task from a file or text, takes `run` as an optional first word, and refuses what it does not know", () => {
    const args = parseArgs(["run", "--task", "/tasks/instruction.md", "--out", "/logs/out", "--workdir", "/app", "--timeout", "900", "--model", "opus", "--no-worktrees"], () => "Make the tests pass.");
    expect(args).toMatchObject({ task: "Make the tests pass.", out: "/logs/out", workdir: "/app", timeoutSec: 900, settleSec: 20, model: "opus", worktrees: false, bypass: true, keepBotDir: false, dataDir: null });
    expect(parseArgs(["--instruction", "hi", "--out", "o"]).task).toBe("hi");
    expect(() => parseArgs(["--out", "o"])).toThrow(/--task/);
    expect(() => parseArgs(["--instruction", "hi"])).toThrow(/--out/);
    expect(() => parseArgs(["--instruction", "hi", "--out", "o", "--exec", "docker exec x"])).toThrow(/unknown option --exec/);
    expect(() => parseArgs(["--instruction", "hi", "--out", "o", "--timeout", "soon"])).toThrow(/seconds/);
    expect(() => parseArgs(["--task", "f", "--out", "o"], () => "  \n")).toThrow(/empty/);
  });

  it("starts a real bot that bypasses permissions on a fresh data folder, keeping none of the launching app's own variables", () => {
    expect(runSettings({ bypass: true, worktrees: false })).toEqual({ claudeBypassPermissions: true, codexBypassPermissions: true, resultPublishingChoice: "localOnly", updateCheckEnabled: false, worktreesEnabled: false });
    expect(runSettings({ bypass: false, worktrees: true })).not.toHaveProperty("worktreesEnabled");
    const env = coreEnvironment({ PATH: "/usr/bin", ANTHROPIC_API_KEY: "k", BOTLING_IMPORT_FROM: "/home/me/.claudecodebot", BOTLING_APP_COMMAND: "Botling", BOTLING_CLAUDE_PATH: "/opt/claude" }, "/tmp/data", { model: "opus", bypass: true });
    expect(env).toMatchObject({ PATH: "/usr/bin", ANTHROPIC_API_KEY: "k", BOTLING_DATA_DIR: "/tmp/data", BOTLING_AGENT: "claude", BOTLING_HARMLESS: "0", BOTLING_QUIT_TIDY_MS: "0", BOTLING_MODEL: "opus", BOTLING_CLAUDE_PATH: "/opt/claude" });
    expect(env).not.toHaveProperty("BOTLING_IMPORT_FROM");
    expect(env).not.toHaveProperty("BOTLING_APP_COMMAND");
  });

  it("counts each streamed assistant message's tokens once across head and worker transcripts", () => {
    const root = tempDir("run-transcripts");
    mkdirSync(join(root, "-app"), { recursive: true });
    const line = (id: string, usage: object) => JSON.stringify({ type: "assistant", message: { id, usage } });
    writeFileSync(join(root, "-app", "head.jsonl"), [line("a", { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 }), line("a", { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 }), JSON.stringify({ type: "user", message: { content: "usage" } })].join("\n"));
    writeFileSync(join(root, "-app", "worker.jsonl"), line("b", { input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 3 }));
    const found = claudeTranscripts(root, 0);
    expect(found.sessions).toBe(2);
    expect(found.usage).toEqual({ input_tokens: 11, output_tokens: 7, cache_creation_input_tokens: 3, cache_read_input_tokens: 100 });
    expect(claudeTranscripts(root, Date.now() + 60_000).sessions).toBe(0);
  });
});

describe("botling run: a whole task on the built core", () => {
  const fakeEnv = (dir: string) => ({ ...process.env, BOTLING_AGENT: "fake", BOTLING_FAKE_CLI: fakeCli, CLAUDE_CONFIG_DIR: join(dir, "claude") });

  it("hands work to a worker, waits for its report and the head's reply, writes the trajectory and exits 0", async () => {
    const dir = tempDir("run-cli");
    const workdir = join(dir, "app");
    mkdirSync(workdir);
    const out = join(dir, "out");
    const lines: string[] = [];
    const result = await run({ ...parseArgs(["--instruction", "/worker write the report", "--out", out, "--workdir", workdir, "--settle", "1", "--timeout", "60"]), dataDir: join(dir, "data") },
      { coreScript, env: fakeEnv(dir), log: (line) => lines.push(line) });
    expect(result.exitCode, lines.join("\n")).toBe(EXIT_OK);
    const summary = JSON.parse(readFileSync(join(out, "summary.json"), "utf8"));
    expect(summary).toMatchObject({ status: "completed", exitCode: 0, turns: 2, failedTurns: 0, workers: 1, lastTurn: "done" });
    expect(summary.finalText).toContain("app_task_result");
    const chat = JSON.parse(readFileSync(join(out, "chat.json"), "utf8"));
    expect(chat.messages.map((m: any) => m.role)).toEqual(["user", "bot", "bot"]);
    expect(chat.messages[0].text).toBe("/worker write the report");
    const [worker] = readdirSync(join(out, "workers"));
    expect(JSON.parse(readFileSync(join(out, "workers", worker!), "utf8"))).toBeTruthy();
    expect(readFileSync(join(out, "chat.md"), "utf8")).toContain("Handed off");
    expect(existsSync(join(out, "botling", "data", "worker-ledger.json"))).toBe(true);
    expect(readFileSync(join(out, "instruction.md"), "utf8")).toBe("/worker write the report");
    expect(readFileSync(join(out, "core.log"), "utf8")).toContain("added project app");
    // The run's own notes folder is not left in the task's folder.
    expect(existsSync(join(workdir, ".bot"))).toBe(false);
  });

  it("exits 124 when the task outlives --timeout, and still writes what there is", async () => {
    const dir = tempDir("run-cli-timeout");
    const workdir = join(dir, "app");
    mkdirSync(workdir);
    const out = join(dir, "out");
    const result = await run({ ...parseArgs(["--instruction", "/slow", "--out", out, "--workdir", workdir, "--settle", "1", "--timeout", "2"]), dataDir: join(dir, "data") },
      { coreScript, env: fakeEnv(dir), log: () => {} });
    expect(result.exitCode).toBe(EXIT_TIMEOUT);
    expect(JSON.parse(readFileSync(join(out, "summary.json"), "utf8"))).toMatchObject({ status: "timeout", exitCode: 124 });
    expect(existsSync(join(out, "chat.json"))).toBe(true);
  });

  it("exits 1 for a folder that is not there", async () => {
    const dir = tempDir("run-cli-missing");
    await expect(run(parseArgs(["--instruction", "hi", "--out", join(dir, "out"), "--workdir", join(dir, "nope")]), { coreScript, env: fakeEnv(dir), log: () => {} })).rejects.toThrow(/no folder/);
    expect(EXIT_ERROR).toBe(1);
  });
});
