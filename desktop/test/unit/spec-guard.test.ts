// spec/ is written only by the strong model and people: an app-managed worker on another model is refused any
// write there (its file tools and the shell commands that clearly write there), reading stays open, and an opus
// worker (settings.json `specWriters`, default ["opus"]) goes through.
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeHead, SPEC_GUARD_HOOK, type HeadConfig } from "../../src/core/agent/head";
import { AgyMcpBridge } from "../../src/core/agent/agy-mcp";
import { CodexSession, type CodexConfig, type CodexOutput } from "../../src/core/agent/codex";
import { claudeHarness } from "../claude-workers-fake";
import { DEFAULT_SPEC_WRITERS, maySpecWrite, shellWritesSpec, specGuardDecision, specWriteCall, specWriters, SPEC_DENIED } from "../../src/core/spec-guard";

function repo() {
  const root = mkdtempSync(join(tmpdir(), "botling-spec-guard-"));
  mkdirSync(join(root, ".git"));
  mkdirSync(join(root, "spec", "models"), { recursive: true });
  mkdirSync(join(root, "desktop", "src"), { recursive: true });
  return root;
}
const hook = (tool_name: string, tool_input: Record<string, unknown>) => ({ hook_event_name: "PreToolUse", tool_name, tool_input });
const denied = (decision: Record<string, unknown>) => (decision as any).hookSpecificOutput?.permissionDecision === "deny";

describe("who may write spec/", () => {
  it("opus by default, by family or full id; sonnet, haiku, other engines and an unknown model may not", () => {
    expect(DEFAULT_SPEC_WRITERS).toEqual(["opus"]);
    for (const model of ["opus", "claude-opus-5-5", "opus[1m]", "Claude Opus 4.5 (Thinking)"]) expect(maySpecWrite(model)).toBe(true);
    for (const model of ["sonnet", "haiku", "claude-sonnet-5-5", "claude-haiku-5-5", "gpt-5.2-codex", "gemini-3-pro", "", null, undefined]) expect(maySpecWrite(model)).toBe(false);
  });

  it("reads the allowlist from settings.json, with the default when it is missing", () => {
    expect(specWriters({})).toEqual(["opus"]);
    expect(specWriters({ specWriters: ["Opus", "sonnet", 3] })).toEqual(["opus", "sonnet"]);
    expect(specWriters({ specWriters: [] })).toEqual([]);
    expect(maySpecWrite("claude-sonnet-5-5", specWriters({ specWriters: ["sonnet"] }))).toBe(true);
    expect(maySpecWrite("opus", [])).toBe(false);
  });
});

describe("the worker hook", () => {
  it("denies a sonnet worker's Edit, Write, MultiEdit and NotebookEdit into spec/", () => {
    const root = repo();
    for (const model of ["sonnet", "haiku", "claude-sonnet-5-5"]) {
      const guard = { model, cwd: root };
      for (const [tool, input] of [
        ["Edit", { file_path: join(root, "spec/models/restart/Restart.tla"), old_string: "a", new_string: "b" }],
        ["Write", { file_path: "spec/reference/restart.ts", content: "x" }],
        ["MultiEdit", { file_path: join(root, "spec", "README.md"), edits: [] }],
        ["NotebookEdit", { notebook_path: join(root, "spec/tests/n.ipynb"), new_source: "" }],
        ["Write", { file_path: join(root, "desktop/../spec/x.md"), content: "x" }],
      ] as const) {
        const decision = specGuardDecision(hook(tool, input), guard);
        expect(denied(decision), `${model} ${tool} ${JSON.stringify(input)}`).toBe(true);
        expect((decision as any).hookSpecificOutput.permissionDecisionReason).toBe(SPEC_DENIED);
      }
    }
  });

  it("allows an opus worker to write spec/", () => {
    const root = repo();
    for (const model of ["opus", "claude-opus-5-5"]) {
      expect(specGuardDecision(hook("Edit", { file_path: join(root, "spec/models/restart/Restart.tla") }), { model, cwd: root })).toEqual({});
      expect(specGuardDecision(hook("Bash", { command: "echo x > spec/a.md" }), { model, cwd: root })).toEqual({});
    }
  });

  it("always allows reading spec/, and writing elsewhere", () => {
    const root = repo();
    const guard = { model: "haiku", cwd: root };
    for (const [tool, input] of [
      ["Read", { file_path: join(root, "spec/README.md") }],
      ["Glob", { pattern: "spec/**/*.tla" }],
      ["Grep", { pattern: "TypeOK", path: join(root, "spec") }],
      ["Bash", { command: "cat spec/README.md && grep -rn TypeOK spec/models | head" }],
      ["Bash", { command: "spec/tools/check-models.sh" }],
      ["Bash", { command: "cd desktop && npm run test:spec" }],
      ["Bash", { command: "cp spec/README.md /tmp/readme.md" }],
      ["Bash", { command: "git diff -- spec/ > /tmp/spec.diff" }],
      ["Write", { file_path: join(root, "desktop/src/a.ts"), content: "x" }],
      ["Write", { file_path: join(root, "specs/notes.md"), content: "x" }],
      ["Edit", { file_path: join(root, "desktop/spec-adapters/restart-adapter.ts") }],
    ] as const) expect(specGuardDecision(hook(tool, input), guard), `${tool} ${JSON.stringify(input)}`).toEqual({});
    expect(specGuardDecision({ hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: join(root, "spec/a") } }, guard)).toEqual({});
  });

  it("follows a symlink into spec/ and a different letter case", () => {
    const root = repo();
    symlinkSync(join(root, "spec"), join(root, "s"));
    expect(specWriteCall("Write", { file_path: join(root, "s/models/x.tla") }, root)).toBe(true);
    if (process.platform === "darwin") expect(specWriteCall("Write", { file_path: join(root, "Spec/x.tla") }, root)).toBe(true);
  });

  it("guards the repository's spec/ from a worker that runs in a subfolder", () => {
    const root = repo();
    expect(specWriteCall("Write", { file_path: "../spec/x.md" }, join(root, "desktop"))).toBe(true);
    expect(shellWritesSpec("rm ../spec/README.md", join(root, "desktop"))).toBe(true);
  });
});

describe("shell commands that write spec/ (best effort)", () => {
  const root = repo();
  it.each([
    "echo x > spec/a.md",
    "echo x >> ./spec/a.md",
    "cat a 2> spec/err.log",
    "printf x | tee spec/models/a.tla",
    "rm -rf spec",
    "rm spec/models/restart/Restart.cfg",
    "mv spec/README.md /tmp/x",
    "cp /tmp/x spec/README.md",
    "cp -t spec/models a b",
    "touch spec/new.md",
    "mkdir -p spec/models/extra",
    "sed -i '' 's/a/b/' spec/README.md",
    "perl -pi -e 's/a/b/' spec/README.md",
    "git checkout main -- spec/models",
    "git restore spec/",
    "find spec -name '*.out' -delete",
    "find spec -name x -exec rm {} \\;",
    "ls spec/traces | xargs rm",
    "cd spec && rm README.md",
    "cd desktop; cd ../spec; touch x",
    "bash -c 'echo x > spec/a'",
    "sudo FOO=1 rm spec/a",
    "python3 -c \"open('spec/a.md','w').write('x')\"",
    "node -e \"require('fs').writeFileSync('spec/a', 'x')\"",
    "dd if=/dev/zero of=spec/blob bs=1 count=1",
  ])("denies %s", (command) => {
    expect(shellWritesSpec(command, root)).toBe(true);
  });

  it.each([
    "cat spec/README.md",
    "ls -la spec/models",
    "grep -rn Init spec/ > /tmp/hits",
    "spec/tools/tlc.sh spec/models/restart/Restart.tla",
    "npx vitest run ../spec/tests/restart.spec.test.ts",
    "git log -- spec/",
    "git diff main -- spec",
    "cp spec/README.md /tmp/",
    "find spec -name '*.tla'",
    "node -e \"console.log(require('fs').readFileSync('spec/README.md','utf8'))\"",
    "echo spec > /tmp/name",
    "rm -rf desktop/out specs",
    "ls 2>&1",
  ])("allows %s", (command) => {
    expect(shellWritesSpec(command, root)).toBe(false);
  });
});

describe("a Claude worker's own claude process", () => {
  function transport(config: Partial<HeadConfig>) {
    const writes: any[] = [];
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
    child.stdin.on("data", (chunk) => { for (const line of String(chunk).split("\n").filter(Boolean)) writes.push(JSON.parse(line)); });
    const head = new ClaudeHead({ command: "claude", cwd: repo(), sessionId: "s", resume: false, allowedTools: [], ...config }, { onItem() {}, onExit() {} },
      { platform: "test", verified: true, spawn: () => ({ pid: 1, child, terminate: async () => ({ killed: [], forced: false }) }) } as any);
    head.start();
    const ask = async (id: string, tool_name: string, tool_input: Record<string, unknown>) => {
      child.stdout.write(JSON.stringify({ type: "control_request", request_id: id, request: { subtype: "hook_callback", callback_id: SPEC_GUARD_HOOK, input: hook(tool_name, tool_input) } }) + "\n");
      await new Promise((resolve) => setTimeout(resolve, 10));
      return writes.find((w) => w.response?.request_id === id).response.response;
    };
    return { head, writes, ask };
  }

  it("registers the spec/ hook for a worker, before any input, and not for a bot head", () => {
    const worker = transport({ model: "sonnet", specGuard: { writers: ["opus"] } });
    expect(worker.writes[0].request).toMatchObject({ subtype: "initialize",
      hooks: { PreToolUse: expect.arrayContaining([{ matcher: "^(Edit|Write|MultiEdit|NotebookEdit|Bash)$", hookCallbackIds: [SPEC_GUARD_HOOK] }]) } });
    expect(JSON.stringify(transport({ model: "sonnet", tools: ["Read"] }).writes)).not.toContain(SPEC_GUARD_HOOK);
    expect(JSON.stringify(transport({ model: "sonnet", specGuard: { writers: ["opus"] }, harmless: true }).writes)).not.toContain(SPEC_GUARD_HOOK);
  });

  it("denies a sonnet worker's write into spec/ and lets its read through", async () => {
    const t = transport({ model: "sonnet", specGuard: { writers: ["opus"] } });
    expect(denied(await t.ask("h1", "Write", { file_path: join(t.head.config.cwd, "spec/a.tla"), content: "x" }))).toBe(true);
    expect(denied(await t.ask("h2", "Bash", { command: "rm -rf spec/models" }))).toBe(true);
    expect(await t.ask("h3", "Read", { file_path: join(t.head.config.cwd, "spec/README.md") })).toEqual({});
    expect(await t.ask("h4", "Write", { file_path: join(t.head.config.cwd, "desktop/a.ts"), content: "x" })).toEqual({});
  });

  it("allows an opus worker's write into spec/", async () => {
    const t = transport({ model: "claude-opus-5-5", specGuard: { writers: ["opus"] } });
    expect(await t.ask("h1", "Write", { file_path: join(t.head.config.cwd, "spec/a.tla"), content: "x" })).toEqual({});
  });

  it("is on for every Claude worker, with the bot's specWriters or the default", async () => {
    const h = claudeHarness();
    await h.workers.tool("app_handoff", { instructions: "Edit the model" });
    expect(h.heads[0]!.config).toMatchObject({ model: "sonnet", specGuard: { writers: ["opus"] } });
    await h.workers.close();
  });
});

describe("an Antigravity worker's tool bridge", () => {
  const bridges: AgyMcpBridge[] = [];
  afterEach(async () => { await Promise.all(bridges.splice(0).map((b) => b.close())); });
  function bridge(locked: boolean) {
    const cwd = repo();
    mkdirSync(join(cwd, "profile"));
    writeFileSync(join(cwd, "spec", "README.md"), "spec");
    const b = new AgyMcpBridge(cwd, join(cwd, "profile"), undefined, undefined, undefined, () => true, undefined, [], () => locked);
    bridges.push(b);
    b.beginTurn(); // Full permission: the bridge writes itself, no helper or card.
    return { b, cwd };
  }

  it("refuses a locked worker's write_file and shell write into spec/, even with Full permission; reading stays open", async () => {
    const { b, cwd } = bridge(true);
    await expect(b.invoke("write_file", { path: "spec/a.tla", content: "x" })).rejects.toThrow(SPEC_DENIED);
    await expect(b.invoke("run_command", { command: "echo x > spec/a.tla" })).rejects.toThrow(SPEC_DENIED);
    expect(existsSync(join(cwd, "spec", "a.tla"))).toBe(false);
    expect(await b.invoke("read_file", { path: "spec/README.md" })).toBe("spec");
    await b.invoke("write_file", { path: "desktop/a.ts", content: "x" });
    expect(readFileSync(join(cwd, "desktop", "a.ts"), "utf8")).toBe("x");
  });

  it("lets an unlocked one (a spec writer's model, or a bot head) write spec/", async () => {
    const { b, cwd } = bridge(false);
    await b.invoke("write_file", { path: "spec/a.tla", content: "x" });
    expect(readFileSync(join(cwd, "spec", "a.tla"), "utf8")).toBe("x");
  });

  it.runIf(process.platform === "darwin")("outside Full permission, its sandbox denies a shell write the words do not show", async () => {
    const cwd = repo();
    mkdirSync(join(cwd, "profile"));
    const b = new AgyMcpBridge(cwd, join(cwd, "profile"), undefined, undefined, undefined, () => false, undefined, [], () => true);
    bridges.push(b);
    const command = "d=sp; d=${d}ec; echo x > $d/hidden.txt; echo y > ok.txt";
    b.grant("botling_run_command", { command });
    const result = await b.invoke("run_command", { command }) as { exitCode: number | null; output: string };
    expect(existsSync(join(cwd, "spec", "hidden.txt"))).toBe(false);
    expect(readFileSync(join(cwd, "ok.txt"), "utf8")).toBe("y\n");
    expect(result.output).toMatch(/not permitted/i);
  });
});

describe("a Codex worker's approvals", () => {
  const COORD = "coord-thread";
  function session(change: Partial<CodexConfig>) {
    const s = new CodexSession({ cwd: "/tmp/bot", instructions: "Coordinator", workerInstructions: "Worker", resumeThread: null, model: null, workerModel: null, effort: null, restoredWorkers: [], ownerSession: "owner", ...change });
    const all: CodexOutput[] = [];
    const take = (out: CodexOutput[]) => { all.push(...out); return out; };
    take(s.start());
    take(s.receive(JSON.stringify({ id: 1, result: {} })));
    take(s.receive(JSON.stringify({ id: 2, result: { thread: { id: COORD } } })));
    const send = (value: unknown) => take(s.receive(JSON.stringify(value)));
    const writes = (out: CodexOutput[]) => out.filter((o) => o.kind === "write").map((o: any) => o.value);
    const cards = (out: CodexOutput[]) => out.filter((o: any) => o.kind === "item" && o.item.kind === "permission");
    const handed = send({ method: "item/tool/call", id: 600, params: { threadId: COORD, turnId: "t1", callId: "c1", tool: "app_handoff", arguments: { instructions: "Job", name: "Job" } } });
    const start = writes(handed).find((w) => w.method === "thread/start");
    const started = send({ id: start.id, result: { thread: { id: "w1" } } });
    send({ id: writes(started).find((w) => w.method === "turn/start").id, result: { turn: { id: "wt1" } } });
    return { start, send, writes, cards };
  }

  it("declines a gpt worker's patch and command into spec/ without a card, and tells it why", () => {
    const h = session({ workerModel: "gpt-5.2-codex" });
    expect(h.start.params.developerInstructions).toContain(SPEC_DENIED);
    h.send({ method: "item/started", params: { threadId: "w1", turnId: "wt1", item: { type: "fileChange", id: "p1", changes: [{ path: "/tmp/bot/spec/models/A.tla", kind: { type: "update" } }] } } });
    const patch = h.send({ method: "item/fileChange/requestApproval", id: 701, params: { threadId: "w1", turnId: "wt1", itemId: "p1" } });
    expect(h.writes(patch)).toContainEqual({ jsonrpc: "2.0", id: 701, result: { decision: "decline" } });
    expect(h.cards(patch)).toEqual([]);
    const command = h.send({ method: "item/commandExecution/requestApproval", id: 702, params: { threadId: "w1", turnId: "wt1", command: "rm -rf spec/traces", cwd: "/tmp/bot", environmentId: "local" } });
    expect(h.writes(command)).toContainEqual({ jsonrpc: "2.0", id: 702, result: { decision: "decline" } });
    // Anything else is asked as before.
    const other = h.send({ method: "item/commandExecution/requestApproval", id: 703, params: { threadId: "w1", turnId: "wt1", command: "rm -rf build", cwd: "/tmp/bot", environmentId: "local" } });
    expect(h.cards(other)).toHaveLength(1);
  });

  it("asks as before for a worker on an allowed model", () => {
    const h = session({ workerModel: "gpt-5.2-codex", specWriters: ["gpt"] });
    expect(h.start.params.developerInstructions).not.toContain(SPEC_DENIED);
    const command = h.send({ method: "item/commandExecution/requestApproval", id: 702, params: { threadId: "w1", turnId: "wt1", command: "rm -rf spec/traces", cwd: "/tmp/bot", environmentId: "local" } });
    expect(h.cards(command)).toHaveLength(1);
  });
});
