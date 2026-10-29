import { afterEach, expect, it, vi } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ClaudeHead } from "../../src/core/agent/head";
import { CodexHead, CodexThreads } from "../../src/core/agent/codex";
import { AgentTurn, childEnvironment, claudeEnvironment } from "../../src/core/agent/runner";
import { fakeCli, fakeCodex, tempDir, until } from "../helpers";

afterEach(() => vi.unstubAllEnvs());
function fixture(engine: "claude" | "codex") {
  const cwd = tempDir("entrypoint-env-");
  const output = join(cwd, "environment.json"), script = join(cwd, "stub.mjs");
  writeFileSync(script, `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(output)}, JSON.stringify({ entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT,
inherited: process.env.BOTLING_ENV_TEST_INHERITED, extra: process.env.BOTLING_ENV_TEST_EXTRA,
nested: process.env.CLAUDECODE, args: process.argv.slice(2) }));
await import(${JSON.stringify(pathToFileURL(engine === "claude" ? fakeCli : fakeCodex).href)});`);
  vi.stubEnv("CLAUDE_CODE_ENTRYPOINT", "inherited-value");
  vi.stubEnv("BOTLING_ENV_TEST_INHERITED", "keep-inherited");
  vi.stubEnv("CLAUDECODE", "nested-session");
  return { config: { command: process.execPath, prefixArgs: [script], cwd,
    env: { BOTLING_ENV_TEST_EXTRA: "keep-extra", CLAUDE_CODE_ENTRYPOINT: "launch-value" },
    sessionId: "entrypoint-session", resume: false },
    read: () => JSON.parse(readFileSync(output, "utf8")) };
}

it.each([undefined, "", "launch-value"])("enforces Claude identity after override %s", value => {
  vi.stubEnv("CLAUDE_CODE_ENTRYPOINT", "inherited-value");
  expect(claudeEnvironment({ CLAUDE_CODE_ENTRYPOINT: value }).CLAUDE_CODE_ENTRYPOINT).toBe("claude-bolting");
  expect(process.env.CLAUDE_CODE_ENTRYPOINT).toBe("inherited-value");
  expect(childEnvironment().CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
  expect(childEnvironment({ CLAUDE_CODE_ENTRYPOINT: value }).CLAUDE_CODE_ENTRYPOINT).toBe(value);
});

it.each([
  { resume: false, monitorWorker: false }, { resume: true, monitorWorker: false },
  { resume: false, monitorWorker: true }, { resume: true, monitorWorker: true },
])("sets spawned Claude env: resume=$resume worker=$monitorWorker", async options => {
  const f = fixture("claude"), items: any[] = [];
  const head = new ClaudeHead({ ...f.config, ...options, allowedTools: [], harmless: true },
    { onItem: item => items.push(item), onExit() {} });
  try {
    head.start(); head.send("hello", "entrypoint-message");
    await until(() => items.some(item => item.kind === "result"), { timeout: 3000 });
    const { args, ...environment } = f.read();
    expect(environment).toEqual({ entrypoint: "claude-bolting", inherited: "keep-inherited", extra: "keep-extra" });
    expect(args).toContain(options.resume ? "--resume" : "--session-id");
  } finally { await head.terminate(100); await head.exited; }
});

it("sets spawned single-turn Claude env", async () => {
  const f = fixture("claude"); let finished = false;
  const turn = new AgentTurn(f.config, { onDelta() {}, onFinish() { finished = true; } });
  try {
    turn.start("hello"); await until(() => finished, { timeout: 3000 });
    expect(f.read()).toMatchObject({ entrypoint: "claude-bolting", inherited: "keep-inherited", extra: "keep-extra" });
  } finally { await turn.stop(); await turn.exited; }
});

it.each([undefined, "launch-value"])("preserves spawned Codex env with override %s", async entrypoint => {
  const f = fixture("codex"), items: any[] = [];
  const head = new CodexHead({ ...f.config, env: { ...f.config.env, CLAUDE_CODE_ENTRYPOINT: entrypoint },
    threads: new CodexThreads(join(f.config.cwd, "threads")), instructions: "", workerInstructions: null },
    { onItem: item => items.push(item), onExit() {} });
  try {
    head.start(); head.send("hello", "entrypoint-message");
    await until(() => items.some(item => item.kind === "result"), { timeout: 3000 });
    expect(f.read().entrypoint).toBe(entrypoint);
    expect(f.read()).toMatchObject({ inherited: "keep-inherited", extra: "keep-extra" });
  } finally { await head.terminate(100); await head.exited; }
});
