// Phase 3a against the real CLIs (opt-in: BOTLING_LIVE_PHASE3A=1, `npm run test:live:3a`), three
// calls in all:
// 1. claude 2.1.310 in harmless mode (no tools, no MCP, no CLAUDE.md, no saved session): a message
//    written to its stdin while a turn runs (how a head hears the other head mid-turn) — whether it
//    is read into that turn or answered in a turn of its own, and what command_lifecycle says.
// 2. `codex app-server` (no model call): a monitored command through `command/exec` with the exact
//    parameters the Codex head sends (sandbox said explicitly, network off, output cap).
// 3. Catch-up's isolated `codex exec` summary of three messages, with source cites.
// Codex runs with a throwaway CODEX_HOME holding only a copy of auth.json (deleted afterwards).
import { afterAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { appendFileSync, copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { ClaudeHead } from "../../src/core/agent/head";
import type { StreamItem } from "../../src/core/agent/stream";
import { codexSummarizer, summaryPrompt } from "../../src/core/catchup";
import type { ChatRecord } from "../../src/core/store/records";
import { tempDir, until } from "../helpers";

const live = process.env.BOTLING_LIVE_PHASE3A === "1";
/** What each check saw, also written to a file (console output may be swallowed). */
function report(name: string, value: unknown) {
  console.log(`${name}:`, JSON.stringify(value));
  if (process.env.BOTLING_LIVE_REPORT) appendFileSync(process.env.BOTLING_LIVE_REPORT, `${JSON.stringify({ name, value })}\n`);
}
let codexHome: string | null = null;
afterAll(() => { if (codexHome) rmSync(codexHome, { recursive: true, force: true }); });

function home(): string {
  if (codexHome) return codexHome;
  const base = process.env.TMPDIR && process.env.TMPDIR.startsWith("/Volumes/") ? process.env.TMPDIR : tempDir("codex-home-base");
  codexHome = mkdtempSync(join(base, "codex-home-"));
  copyFileSync(join(homedir(), ".codex", "auth.json"), join(codexHome, "auth.json"));
  return codexHome;
}

describe.skipIf(!live)("Phase 3a, real CLIs", () => {
  it("claude: a message written while a turn runs — read into it, or a turn of its own", async () => {
    const items: StreamItem[] = [];
    let exited = false;
    const head = new ClaudeHead({ command: "claude", cwd: tempDir("live-claude"), sessionId: randomUUID(), resume: false, allowedTools: [], harmless: true }, {
      onItem: (item) => items.push(item),
      onExit: () => { exited = true; },
    });
    head.start();
    const first = randomUUID();
    head.send("Write the numbers from 1 to 80, one per line, nothing else.", first);
    await until(() => items.some((item) => item.kind === "delta"), { timeout: 120_000, what: "claude to start writing" });
    const note = randomUUID();
    head.send("(App: Codex, this bot's other head, replied in this chat:)\nCodex says: I counted to 3. When you finish, add one last line: HEARD.", note);
    await until(() => items.filter((item) => item.kind === "result").length >= 1, { timeout: 180_000, what: "the first result" });
    // A turn of its own for the note would end with a second result: wait a little for one.
    await new Promise((resolve) => setTimeout(resolve, 20_000));
    const results = items.filter((item): item is Extract<StreamItem, { kind: "result" }> => item.kind === "result");
    const lifecycle = items.filter((item) => item.kind === "command").map((item) => `${(item as { id: string }).id === note ? "note" : (item as { id: string }).id === first ? "first" : "?"}:${(item as { state: string }).state}`);
    report("claude mid-turn", { results: results.map((r) => ({ ok: r.ok, tail: r.text.slice(-60) })), lifecycle });
    head.finish();
    await until(() => exited, { timeout: 30_000, what: "claude to exit" });
    expect(results.length).toBeGreaterThanOrEqual(1);
  }, 300_000);

  it("codex app-server: command/exec as a monitor runs it (sandboxed, network off) and gives its exit code and output", async () => {
    const folder = tempDir("live-monitor");
    const child = spawn("codex", ["app-server"], { cwd: folder, env: { ...process.env, CODEX_HOME: home() }, stdio: ["pipe", "pipe", "pipe"] });
    const responses = new Map<number, any>();
    createInterface({ input: child.stdout }).on("line", (line) => {
      try { const value = JSON.parse(line); if (typeof value.id === "number" && !value.method) responses.set(value.id, value); } catch { /* not ours */ }
    });
    child.stderr.resume();
    const send = (value: unknown) => child.stdin.write(`${JSON.stringify(value)}\n`);
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "claudecodebot", title: "Botling", version: "1" }, capabilities: { experimentalApi: true } } });
    await until(() => responses.get(1), { timeout: 60_000, what: "initialize" });
    send({ jsonrpc: "2.0", method: "initialized" });
    const id = randomUUID();
    send({ jsonrpc: "2.0", id: 2, method: "command/exec", params: {
      command: ["/bin/zsh", "-c", "echo monitored; echo oops >&2; exit 3"], cwd: folder, processId: id, disableTimeout: true, outputBytesCap: 8192,
      sandboxPolicy: { type: "workspaceWrite", writableRoots: [folder], networkAccess: false },
    } });
    const answer = await until(() => responses.get(2), { timeout: 60_000, what: "command/exec" });
    report("command/exec", answer);
    child.stdin.end();
    child.kill("SIGTERM");
    expect(answer.error).toBeUndefined();
    expect(answer.result).toMatchObject({ exitCode: 3 });
    expect(answer.result.stdout).toContain("monitored");
  }, 120_000);

  it("Catch-up: the isolated read-only codex exec writes 1–5 bullets citing the messages", async () => {
    const at = (offset: number) => (Date.now() - Date.UTC(2001, 0, 1)) / 1000 + offset;
    const messages: ChatRecord[] = [
      { id: "11111111-0000-4000-8000-000000000001", role: "bot", text: "The build passed: 214 tests, 0 failures.", date: at(0), engine: "claude" },
      { id: "11111111-0000-4000-8000-000000000002", role: "bot", text: "Deploy to staging is still running (step 3 of 5).", date: at(60), engine: "codex" },
      { id: "11111111-0000-4000-8000-000000000003", role: "bot", text: "Should I merge PR #42 now or wait for review?", date: at(120), engine: "claude", choices: [{ label: "Merge now", recommended: true }, { label: "Wait", recommended: false }] },
    ];
    const prompt = summaryPrompt(messages, null, [], (m) => `Garden · ${m.engine === "codex" ? "Codex" : "Claude"}`);
    const summarize = codexSummarizer({ file: "codex", env: { CODEX_HOME: home() } }, 120_000);
    const bullets = await summarize(prompt, process.env.BOTLING_CATCHUP_MODEL ?? "gpt-6-luna", "en");
    report("catch-up bullets", bullets);
    expect(bullets.length).toBeGreaterThanOrEqual(1);
    expect(bullets.length).toBeLessThanOrEqual(5);
    expect(bullets.join("\n")).toMatch(/\[\[source:11111111-0000-4000-8000-00000000000[123]/);
  }, 180_000);
});
