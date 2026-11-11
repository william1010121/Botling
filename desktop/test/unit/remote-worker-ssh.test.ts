// Remote workers end to end over the ssh path (multi-machine phase 1, M1): the Claude worker adapter hands a worker to
// a machine; Botling uploads its agent (out/agent/botling-agent.cjs) with a fake ssh that runs the "remote" command
// here under another HOME; the agent runs the fake claude; the approval card comes back and is answered; the worker's
// change comes back as a local branch on the commit it started from.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ClaudeWorkers } from "../../src/core/agent/claude-workers";
import type { HeadConfig } from "../../src/core/agent/head";
import { RemoteWorkers } from "../../src/remote/service";

const root = resolve(__dirname, "../..");
const bundle = join(root, "out/agent/botling-agent.cjs");
const fakeSsh = join(root, "test/fixtures/fake-ssh.sh");
const fakeClaude = join(root, "test/fixtures/fake-claude.mjs");

const until = async (what: string, check: () => boolean, ms = 20_000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

describe("remote worker over ssh", () => {
  const saved: Record<string, string | undefined> = {};
  const env = {
    BOTLING_SSH_NO_CONTROL: "1", BOTLING_AGENT_NO_LOGIN_PATH: "1",
    BOTLING_AGENT_CLAUDE: process.execPath, BOTLING_AGENT_CLAUDE_ARGS: JSON.stringify([fakeClaude]), FAKE_CLAUDE_RUN_TOOLS: "1",
  };
  let dir: string;
  beforeAll(() => {
    for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }
    dir = mkdtempSync(join(tmpdir(), "botling-remote-ssh-"));
  });
  afterAll(() => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    rmSync(dir, { recursive: true, force: true });
  });

  it("installs the agent, runs the worker there, takes its approval and brings its branch back", async () => {
    expect(existsSync(bundle), "out/agent/botling-agent.cjs (node build.mjs)").toBe(true);
    const home = join(dir, "machine-home"), data = join(dir, "data"), project = join(dir, "project");
    mkdirSync(home, { recursive: true });
    mkdirSync(project, { recursive: true });
    process.env.FAKE_SSH_HOME = home;
    git(project, "init", "-q", "-b", "main");
    git(project, "config", "user.name", "Test"); git(project, "config", "user.email", "test@example.invalid");
    writeFileSync(join(project, "README.md"), "hello\n");
    git(project, "add", "."); git(project, "commit", "-q", "-m", "first");
    const base = git(project, "rev-parse", "HEAD");

    const remote = new RemoteWorkers({ dataDir: data, bundle, ssh: fakeSsh, waits: [50, 100, 200] });
    const asked = remote.machines.add({ name: "box", via: "ssh", host: "box", hostKey: { fingerprint: "SHA256:test", lines: ["ssh-ed25519 AAAAtest"], known: false } });
    remote.machines.approve(asked.id);
    expect(readFileSync(remote.knownHosts, "utf8")).toBe(`botling-${asked.id} ssh-ed25519 AAAAtest\n`);

    const items: any[] = [], reports: { id: string; text: string }[] = [];
    const baseConfig: HeadConfig = { command: "claude", cwd: project, sessionId: "coordinator", resume: true, allowedTools: ["Read"], model: "sonnet" };
    const workers = new ClaudeWorkers({
      file: join(dir, "claude-workers.json"), ownerSessionId: () => "coordinator", base: () => baseConfig, cwd: () => project,
      subagentModel: () => null, settleMs: 5, keepAliveMs: 60_000, home: join(dir, "home"), remote: () => remote,
    }, (item) => items.push(item), (id, text) => { reports.push({ id, text }); return true; }, () => { throw new Error("no local process for a remote worker"); });

    // An unknown machine is refused before anything starts.
    await expect(workers.tool("app_handoff", { instructions: "x", name: "Nope", machine: "elsewhere" })).rejects.toThrow(/No machine named "elsewhere"/);

    const started = await workers.tool("app_handoff", { instructions: "/tool echo remote > remote.txt", name: "Remote job", machine: "box" }) as { task_id: string };
    await until("the approval card", () => items.some((i) => i.kind === "permission"), 30_000);
    const card = items.find((i) => i.kind === "permission");
    expect(card).toMatchObject({ tool: "Bash", input: { command: "echo remote > remote.txt" } });
    expect(card.requestId).toBe(`worker:${started.task_id}:1:q1`);
    expect(existsSync(join(home, ".botling-agent/bin/botling-agent"))).toBe(true);
    expect(workers.answer(card.requestId, true, card.input)).toBe(true);

    await until("the report", () => reports.length > 0, 30_000);
    const report = reports[0]!.text;
    expect(report).toContain("Allowed: ran echo remote > remote.txt");
    const branch = /on branch (\S+) here/.exec(report)?.[1];
    expect(branch).toMatch(/^bot\/remote-remote-job-/);
    expect(git(project, "show", `${branch}:remote.txt`)).toBe("remote");
    expect(git(project, "rev-parse", `${branch}^`)).toBe(base);
    expect(git(project, "rev-parse", "HEAD")).toBe(base);
    // The machine kept the session's log and its worktree under ~/.botling-agent.
    expect(existsSync(join(home, ".botling-agent/sessions", started.task_id, "log.jsonl"))).toBe(true);
    expect(remote.status(started.task_id)).toMatchObject({ machine: "box" });

    await workers.close();
    remote.close();
  }, 90_000);

  it("a lost connection interrupts the worker; an answer meanwhile is refused with a note; it resumes on its session", async () => {
    const home = join(dir, "home-2"), data = join(dir, "data-2"), project = join(dir, "project-2");
    mkdirSync(home, { recursive: true });
    mkdirSync(project, { recursive: true });
    process.env.FAKE_SSH_HOME = home;
    git(project, "init", "-q", "-b", "main");
    git(project, "config", "user.name", "Test"); git(project, "config", "user.email", "test@example.invalid");
    writeFileSync(join(project, "a.txt"), "a\n");
    git(project, "add", "."); git(project, "commit", "-q", "-m", "first");
    const log = join(dir, "claude-2.log");
    process.env.FAKE_CLAUDE_LOG = log;

    const remote = new RemoteWorkers({ dataDir: data, bundle, ssh: fakeSsh, waits: [50, 100, 200] });
    const m = remote.machines.add({ name: "box", via: "ssh", host: "box", hostKey: { fingerprint: "SHA256:test", lines: ["ssh-ed25519 AAAAtest"], known: false } });
    remote.machines.approve(m.id);
    const items: any[] = [], reports: { id: string; text: string }[] = [];
    const workers = new ClaudeWorkers({
      file: join(dir, "claude-workers-2.json"), ownerSessionId: () => "coordinator", base: () => ({ command: "claude", cwd: project, sessionId: "c", resume: true, allowedTools: [] }), cwd: () => project,
      subagentModel: () => null, settleMs: 5, keepAliveMs: 60_000, home: join(dir, "home"), remote: () => remote,
    }, (item) => items.push(item), (id, text) => { reports.push({ id, text }); return true; }, () => { throw new Error("no local process"); });
    try {
      const { task_id } = await workers.tool("app_handoff", { instructions: "/tool echo hi", name: "Lossy", machine: "box" }) as { task_id: string };
      await until("the card", () => items.some((i) => i.kind === "permission"), 30_000);
      const card = items.find((i) => i.kind === "permission");
      const session = remote.session(task_id)!;
      // The connection drops (the network, sleep): the agent stops claude; the app reconnects and attaches.
      session.link!.close();
      await until("the cut", () => session.w === "interrupted" || session.gen > 1, 10_000);
      // The answer meanwhile does not reach the claude that asked: the card comes back, saying so.
      if (session.conn !== "up" || !session.cards.get("q1")?.live) {
        workers.answer(card.requestId, true, card.input);
        await until("the card again", () => items.filter((i) => i.kind === "permission").length > 1, 5_000);
        expect(items.filter((i) => i.kind === "permission").at(-1).summary).toMatch(/^Your answer (was not sent|did not reach)/);
      }
      await until("the resumed run's report", () => reports.length > 0, 30_000);
      const starts = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      expect(starts.length).toBe(2);
      expect(starts[1].resume).toBe(true);
      expect(starts[1].session).toBe(starts[0].session);
      expect(session.gen).toBeGreaterThanOrEqual(2);
    } finally {
      delete process.env.FAKE_CLAUDE_LOG;
      await workers.close();
      remote.close();
    }
  }, 90_000);
});
