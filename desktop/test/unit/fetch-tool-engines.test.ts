// M5-07d review: a worker that names app_fetch is refused on every engine, not only in the core (`Bot.fetchTool`
// refuses caller "worker"). These pin what each engine hands the core as the caller, and the engine's own refusal of
// a tool its worker was not given; before the review, dropping any of them left every test green.
// - Codex: the only Botling-side line is the thread of the call (a worker's thread -> `worker: true`).
// - Claude: a worker's head lists only the worker tools (head.ts refuses others); its handler names the caller "worker".
// - Antigravity: a worker's bridge lists only the worker tools and refuses others before the call reaches the bot.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodexSession, type CodexConfig, type CodexOutput } from "../../src/core/agent/codex";
import { AgyMcpBridge } from "../../src/core/agent/agy-mcp";
import type { ClaudeWorkers } from "../../src/core/agent/claude-workers";
import { claudeHarness } from "../claude-workers-fake";
import { tempDir } from "../helpers";

const ARGS = { machine: "build-box", path: "~/src/app", purpose: "Read the build logs" };

describe("Codex: the caller is told by the thread of the call", () => {
  const session = () => {
    const config: CodexConfig = { cwd: "/tmp/bot", instructions: "Coordinator", workerInstructions: "Worker", resumeThread: null, model: null, workerModel: null, effort: null, restoredWorkers: [], ownerSession: "owner-session" };
    const s = new CodexSession(config);
    s.start();
    s.receive(JSON.stringify({ id: 1, result: {} }));
    s.receive(JSON.stringify({ id: 2, result: { thread: { id: "coord" } } }));
    return s;
  };
  const call = (s: CodexSession, threadId: string): CodexOutput[] =>
    s.receive(JSON.stringify({ method: "item/tool/call", id: 77, params: { threadId, turnId: "t1", callId: "c1", tool: "app_fetch", arguments: ARGS } }));

  it("the coordinator's thread: a coordinator call", () => {
    expect(call(session(), "coord")).toEqual([{ kind: "browser", rpcId: 77, tool: "app_fetch", args: ARGS }]);
  });

  it("any other thread (a worker's): marked as a worker's call, so the bot refuses it", () => {
    expect(call(session(), "w1")).toEqual([{ kind: "browser", rpcId: 77, tool: "app_fetch", args: ARGS, worker: true }]);
  });
});

describe("Claude: a worker's head", () => {
  const made: ClaudeWorkers[] = [];
  afterEach(async () => { for (const w of made.splice(0)) await w.close(); });

  it("does not list app_fetch, and a bot tool call from it reaches the bot as the worker's", async () => {
    const h = claudeHarness(tempDir("fetch-engines-claude"));
    made.push(h.workers);
    const calls: unknown[][] = [];
    (h.workers as unknown as { adapter: { options: Record<string, unknown> } }).adapter.options.browser = async (...args: unknown[]) => { calls.push(args); return "refused by the bot"; };
    await h.workers.tool("app_handoff", { name: "Research", instructions: "Look" });
    const head = h.heads[0]!;
    expect(head.config.appMcp?.tools.map((tool: { name: string }) => tool.name)).not.toContain("app_fetch");
    await head.handlers.onAppTool!("app_fetch", ARGS);
    expect(calls).toEqual([["app_fetch", ARGS, "worker"]]);
  });
});

describe("Antigravity: a worker's bridge", () => {
  it("does not list app_fetch and refuses it before the bot is asked", async () => {
    const cwd = tempDir("fetch-engines-agy");
    mkdirSync(join(cwd, "profile"));
    const calls: unknown[][] = [];
    const browser = async (...args: unknown[]) => { calls.push(args); return "ok"; };
    // As AgyAcpHead.connectTools builds a worker's bridge: no delegate, a note to its owner, the bot tools.
    const worker = new AgyMcpBridge(cwd, join(cwd, "profile"), undefined, undefined, undefined, () => false, undefined, [], () => true, () => ({}), browser);
    expect(worker.tools.map((tool) => tool.name)).not.toContain("app_fetch");
    await expect(worker.invoke("app_fetch", ARGS)).rejects.toThrow("Unsupported tool.");
    expect(calls).toEqual([]);
  });
});
