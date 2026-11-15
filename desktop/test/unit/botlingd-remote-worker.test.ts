// M5-11 check: a bot on a Botling 3 server (`botlingd`) starts and follows a worker on another machine through
// `botling-agent` (2.x remote workers, via ssh and via relay) using `botlingd`'s own core options (`coreProcessOptions`),
// with nothing Botling-3-specific in that path.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeHead } from "../../src/core/agent/head";
import type { Entry, Message, MessageOf, Slot } from "../../src/protocol";
import { gitRpc } from "../../src/remote/agent/git";
import { AgentServer, machineConfig } from "../../src/remote/agent/server";
import { APP_VERSION } from "../../src/remote/protocol";
import { MachineStore } from "../../src/remote/machines";
import { AgentRelay, pairMachine } from "../../src/remote/relay/agent";
import { MiniWebSocket } from "../../src/remote/relay/ws";
import { Botlingd } from "../../src/server/botlingd";
import { botlingdEnv, ScriptClient, testRoot } from "../botlingd-harness";
import { desktop, until } from "../helpers";

const bundle = join(desktop, "out/agent/botling-agent.cjs");
const fakeSsh = join(desktop, "test/fixtures/fake-ssh.sh");
const fakeClaude = join(desktop, "test/fixtures/fake-claude.mjs");

// relay/ is its own package; load at run time so desktop's tsc does not type-check it.
const relayServerModule = new URL("../../../relay/src/server.ts", import.meta.url).href;
const relayConfigModule = new URL("../../../relay/src/config.ts", import.meta.url).href;

const isResult = (slot: Slot) => (m: Message): m is MessageOf<"cmd.result"> =>
  m.t === "cmd.result" && m.slot.target === slot.target && m.slot.n === slot.n && m.slot.originEpoch === slot.originEpoch;

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function initGitRepo(folder: string): void {
  mkdirSync(folder, { recursive: true });
  git(folder, "init", "-q", "-b", "main");
  git(folder, "config", "user.name", "Test");
  git(folder, "config", "user.email", "test@example.invalid");
  writeFileSync(join(folder, "README.md"), "hello\n");
  git(folder, "add", ".");
  git(folder, "commit", "-q", "-m", "first");
}

function readJsonLines(file: string): Array<Record<string, unknown>> {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function isUnder(childPath: unknown, parentRealPath: string): boolean {
  if (typeof childPath !== "string" || !childPath) return false;
  try {
    const resolved = existsSync(childPath) ? realpathSync(childPath) : childPath;
    return resolved === parentRealPath || resolved.startsWith(`${parentRealPath}/`);
  } catch {
    return childPath.startsWith(`${parentRealPath}/`);
  }
}

describe("botlingd remote workers (M5-11)", () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanups.length) {
      const fn = cleanups.pop()!;
      await fn();
    }
  });

  function withEnv(overrides: Record<string, string>): void {
    const saved: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(overrides)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    cleanups.push(() => {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });
  }

  function makeTestDirs(): {
    root: string;
    dataDir: string;
    remoteHome: string;
    project: string;
    sshLog: string;
    claudeLog: string;
    inputLog: string;
    pidsFile: string;
  } {
    const root = testRoot("botlingd-rw");
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const dataDir = join(root, "data");
    const remoteHome = join(root, "remote-home");
    const project = join(root, "project");
    mkdirSync(remoteHome, { recursive: true });
    initGitRepo(project);
    const pidsFile = join(root, "pids.log");
    cleanups.push(() => {
      if (!existsSync(pidsFile)) return;
      for (const line of readFileSync(pidsFile, "utf8").split("\n")) {
        const pid = Number(line.trim());
        if (Number.isInteger(pid) && pid > 0) {
          try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
        }
      }
    });
    return {
      root,
      dataDir,
      remoteHome,
      project,
      sshLog: join(root, "ssh.log"),
      claudeLog: join(root, "claude.log"),
      inputLog: join(root, "input.log"),
      pidsFile,
    };
  }

  async function startBotlingd(dataDir: string): Promise<{ daemon: Botlingd; client: ScriptClient; inc: string; originEpoch: string }> {
    const daemon = await Botlingd.start({
      env: botlingdEnv(dataDir, {
        BOTLING_REMOTE_WORKERS: "1",
        BOTLING_SERVER_PORT: "off",
        BOTLING_SERVER_BACKUP_CHECK_MS: "0",
      }),
      outDir: join(desktop, "out"),
    });
    cleanups.push(() => daemon.stop());

    const client = new ScriptClient("script");
    cleanups.push(() => client.close());
    await client.connect(daemon.paths.socket, daemon.token);
    await client.sub(client.srv);
    const srvSnap = await client.wait((m): m is MessageOf<"snap"> => m.t === "snap" && m.stream === client.srv, "srv snap");
    return { daemon, client, inc: srvSnap.logId, originEpoch: client.originEpoch };
  }

  async function addConfiguredProject(
    client: ScriptClient,
    inc: string,
    originEpoch: string,
    project: string,
    machineName: string,
    srvSeq: { n: number },
  ): Promise<string> {
    const addSlot: Slot = { origin: "script", originEpoch, target: client.srv, n: srvSeq.n++ };
    client.cmd(addSlot, { type: "projects.add", folder: project }, inc);
    const added = await client.wait(isResult(addSlot), "projects.add result");
    expect(added.outcome.kind).toBe("applied");
    const botId = (added.outcome as { kind: "applied"; result: { botId: string } }).result.botId;

    await client.sub(`bot:${botId}`);
    await client.wait((m): m is MessageOf<"snap"> => m.t === "snap" && m.stream === `bot:${botId}`, "bot snap");

    const cfgSlot: Slot = { origin: "script", originEpoch, target: `bot:${botId}`, n: 1 };
    client.cmd(cfgSlot, { type: "bot.configure", botId, workerMachine: machineName }, inc);
    const configured = await client.wait(isResult(cfgSlot), "bot.configure result");
    expect(configured.outcome.kind).toBe("applied");
    return botId;
  }

  it("starts a remote worker over fake ssh under botlingd's core options, delivers notes, and reports once", async () => {
    expect(existsSync(bundle), "out/agent/botling-agent.cjs (npm run build)").toBe(true);
    const { dataDir, remoteHome, project, sshLog, claudeLog, inputLog, pidsFile } = makeTestDirs();
    const remoteReal = realpathSync(remoteHome);

    const machines = MachineStore.in(dataDir);
    const box = machines.add({
      name: "box",
      via: "ssh",
      host: "box",
      hostKey: { fingerprint: "SHA256:test", lines: ["ssh-ed25519 AAAAtest"], known: false },
    });
    machines.approve(box.id);

    withEnv({
      BOTLING_SSH: fakeSsh,
      BOTLING_SSH_NO_CONTROL: "1",
      FAKE_SSH_HOME: remoteHome,
      FAKE_SSH_LOG: sshLog,
      BOTLING_AGENT_NO_LOGIN_PATH: "1",
      BOTLING_AGENT_CLAUDE: process.execPath,
      BOTLING_AGENT_CLAUDE_ARGS: JSON.stringify([fakeClaude]),
      FAKE_CLAUDE_LOG: claudeLog,
      FAKE_CLAUDE_INPUT: inputLog,
      FAKE_CLAUDE_PIDS: pidsFile,
      FAKE_CLAUDE_RUN_TOOLS: "1",
      FAKE_CLAUDE_REPORT_REPLY: "Worker finished cleanly.",
    });

    const { daemon, client, inc, originEpoch } = await startBotlingd(dataDir);
    const botId = await addConfiguredProject(client, inc, originEpoch, project, "box", { n: 1 });
    const stream = `bot:${botId}`;

    const chatSlot: Slot = { origin: "script", originEpoch, target: stream, n: 2 };
    client.cmd(chatSlot, { type: "chat.send", botId, text: "/worker /notify:question Which DB?" }, inc);
    expect((await client.wait(isResult(chatSlot), "chat.send result")).outcome.kind).toBe("applied");

    await until(
      () => client.entriesOf(stream).find((e) => e.kind === "turn.finished" && String((e.body as { text?: string }).text).includes("Worker finished cleanly.")) ?? null,
      { timeout: 60_000, what: "coordinator report reply" },
    );
    await until(() => (daemon.runningTurns().length === 0 ? true : null), { timeout: 10_000, what: "no running turns" });

    expect(existsSync(join(remoteHome, ".botling-agent/bin/botling-agent"))).toBe(true);
    expect(readFileSync(sshLog, "utf8")).toContain("box ");

    const claudeStarts = readJsonLines(claudeLog);
    expect(claudeStarts.some((s) => isUnder(s.cwd, remoteReal))).toBe(true);

    const entries: Entry[] = client.entriesOf(stream);
    const relayNote = entries.find(
      (e) =>
        e.kind === "message.added" &&
        (e.body as { message: { role: string; text: string } }).message.role === "relay" &&
        (e.body as { message: { text: string } }).message.text.includes('Question from worker "Research": Which DB?'),
    );
    expect(relayNote).toBeDefined();

    expect(
      entries.some((e) => e.kind === "turn.finished" && String((e.body as { text?: string }).text).includes("Answered the worker.")),
    ).toBe(true);

    const completedSubagent = entries.find(
      (e) => e.kind === "subagent.updated" && (e.body as { subagent: { status: string } }).subagent.status === "completed",
    );
    expect(completedSubagent).toBeDefined();

    const reportTurns = entries.filter(
      (e) => e.kind === "turn.finished" && String((e.body as { text?: string }).text).includes("Worker finished cleanly."),
    );
    expect(reportTurns).toHaveLength(1);

    const taskResults = readJsonLines(inputLog).filter((line) => typeof line.text === "string" && line.text.startsWith("<app_task_result "));
    expect(taskResults).toHaveLength(1);
    expect(String(taskResults[0]!.text)).toContain('status="completed"');
    expect(daemon.runningTurns()).toEqual([]);
  }, 90_000);

  it("starts a remote worker over the local relay under botlingd's core options, delivers notes, and reports once", async () => {
    expect(existsSync(bundle), "out/agent/botling-agent.cjs (npm run build)").toBe(true);
    const { dataDir, remoteHome, project, claudeLog, inputLog, pidsFile } = makeTestDirs();
    const remoteReal = realpathSync(remoteHome);

    const { startRelay } = await import(/* @vite-ignore */ relayServerModule);
    const { loadConfig } = await import(/* @vite-ignore */ relayConfigModule);
    const relayServer = await startRelay({ ...loadConfig({}), host: "127.0.0.1", port: 0 });
    cleanups.push(() => relayServer.close());
    const relayUrl = `ws://127.0.0.1:${relayServer.port}/ws`;

    withEnv({
      BOTLING_MACHINE_RELAY: relayUrl,
      BOTLING_AGENT_NO_LOGIN_PATH: "1",
      BOTLING_AGENT_CLAUDE: process.execPath,
      BOTLING_AGENT_CLAUDE_ARGS: JSON.stringify([fakeClaude]),
      FAKE_CLAUDE_LOG: claudeLog,
      FAKE_CLAUDE_INPUT: inputLog,
      FAKE_CLAUDE_PIDS: pidsFile,
      FAKE_CLAUDE_RUN_TOOLS: "1",
      FAKE_CLAUDE_REPORT_REPLY: "Worker finished cleanly.",
    });

    const { daemon, client, inc, originEpoch } = await startBotlingd(dataDir);
    const srvSeq = { n: 1 };

    const pairSlot: Slot = { origin: "script", originEpoch, target: client.srv, n: srvSeq.n++ };
    client.cmd(pairSlot, { type: "machines.pair" }, inc);
    const pairResult = await client.wait(isResult(pairSlot), "machines.pair result");
    expect(pairResult.outcome.kind).toBe("applied");
    const command = (pairResult.outcome as { kind: "applied"; result: { command: string } }).result.command;
    const offer = /botling-machine1\.[A-Za-z0-9_-]+/.exec(command)?.[0];
    expect(offer).toBeTruthy();

    const printed: string[] = [];
    const paired = pairMachine({
      home: remoteHome,
      offer: offer!,
      name: "gpu-box",
      socket: (u) => new MiniWebSocket(u),
      print: (line) => printed.push(line),
    });
    await until(() => (printed.some((line) => line.includes("Code:")) ? true : null), { timeout: 15_000, what: "pairing code" });
    const code = /Code:\s+(\S+)/.exec(printed.join("\n"))?.[1];
    expect(code).toBeTruthy();

    const viewRes = await client.req({ type: "machines.view" });
    expect(viewRes.ok).toBe(true);
    const machineList = (viewRes as { result: { machines: Array<{ id: string; name: string }> } }).result.machines;
    const machine = machineList.find((m) => m.name === "gpu-box");
    expect(machine).toBeDefined();

    const approveSlot: Slot = { origin: "script", originEpoch, target: client.srv, n: srvSeq.n++ };
    client.cmd(approveSlot, { type: "machines.approve", id: machine!.id, code: code! }, inc);
    const approveResult = await client.wait(isResult(approveSlot), "machines.approve result");
    expect(approveResult.outcome.kind).toBe("applied");
    await paired;

    const gitOps = gitRpc(remoteHome);
    const agentServer = new AgentServer({
      home: remoteHome,
      version: APP_VERSION,
      sha: "",
      config: (spec) => machineConfig(spec),
      spawn: (config, handlers) => new ClaudeHead(config, handlers),
      rpc: async (op, args, link) =>
        op === "info" ? { version: APP_VERSION, node: process.version, git: "git", claude: "fake" } : gitOps(op, args, link),
    });
    const agentDaemon = new AgentRelay({
      home: remoteHome,
      server: agentServer,
      socket: (u) => new MiniWebSocket(u),
      waits: [50, 100, 200],
    });
    cleanups.push(async () => {
      await agentDaemon.stop();
      await agentServer.close();
    });
    agentDaemon.start();

    const checkSlot: Slot = { origin: "script", originEpoch, target: client.srv, n: srvSeq.n++ };
    client.cmd(checkSlot, { type: "machines.check", id: machine!.id }, inc);
    expect((await client.wait(isResult(checkSlot), "machines.check result")).outcome.kind).toBe("applied");

    const botId = await addConfiguredProject(client, inc, originEpoch, project, "gpu-box", srvSeq);
    const stream = `bot:${botId}`;

    const chatSlot: Slot = { origin: "script", originEpoch, target: stream, n: 2 };
    client.cmd(chatSlot, { type: "chat.send", botId, text: "/worker /notify:question Which DB?" }, inc);
    expect((await client.wait(isResult(chatSlot), "chat.send result")).outcome.kind).toBe("applied");

    await until(
      () => client.entriesOf(stream).find((e) => e.kind === "turn.finished" && String((e.body as { text?: string }).text).includes("Worker finished cleanly.")) ?? null,
      { timeout: 60_000, what: "coordinator report reply over relay" },
    );
    await until(() => (daemon.runningTurns().length === 0 ? true : null), { timeout: 10_000, what: "no running turns" });

    const claudeStarts = readJsonLines(claudeLog);
    expect(claudeStarts.some((s) => isUnder(s.cwd, remoteReal))).toBe(true);

    const entries: Entry[] = client.entriesOf(stream);
    expect(
      entries.some(
        (e) =>
          e.kind === "message.added" &&
          (e.body as { message: { role: string; text: string } }).message.role === "relay" &&
          (e.body as { message: { text: string } }).message.text.includes('Question from worker "Research": Which DB?'),
      ),
    ).toBe(true);
    expect(
      entries.some((e) => e.kind === "turn.finished" && String((e.body as { text?: string }).text).includes("Answered the worker.")),
    ).toBe(true);
    expect(
      entries.filter((e) => e.kind === "turn.finished" && String((e.body as { text?: string }).text).includes("Worker finished cleanly.")),
    ).toHaveLength(1);

    const taskResults = readJsonLines(inputLog).filter((line) => typeof line.text === "string" && line.text.startsWith("<app_task_result "));
    expect(taskResults).toHaveLength(1);
    expect(String(taskResults[0]!.text)).toContain('status="completed"');
    expect(daemon.runningTurns()).toEqual([]);
  }, 90_000);

  it("killing the fake remote ends the worker with the 2.x message and leaves no bot turn running", async () => {
    expect(existsSync(bundle), "out/agent/botling-agent.cjs (npm run build)").toBe(true);
    const { dataDir, remoteHome, project, sshLog, claudeLog, inputLog, pidsFile } = makeTestDirs();
    const remoteReal = realpathSync(remoteHome);

    const machines = MachineStore.in(dataDir);
    const box = machines.add({
      name: "box",
      via: "ssh",
      host: "box",
      hostKey: { fingerprint: "SHA256:test", lines: ["ssh-ed25519 AAAAtest"], known: false },
    });
    machines.approve(box.id);

    withEnv({
      BOTLING_SSH: fakeSsh,
      BOTLING_SSH_NO_CONTROL: "1",
      FAKE_SSH_HOME: remoteHome,
      FAKE_SSH_LOG: sshLog,
      BOTLING_AGENT_NO_LOGIN_PATH: "1",
      BOTLING_AGENT_CLAUDE: process.execPath,
      BOTLING_AGENT_CLAUDE_ARGS: JSON.stringify([fakeClaude]),
      FAKE_CLAUDE_LOG: claudeLog,
      FAKE_CLAUDE_INPUT: inputLog,
      FAKE_CLAUDE_PIDS: pidsFile,
      FAKE_CLAUDE_REPORT_REPLY: "Worker failure noted.",
    });

    const { daemon, client, inc, originEpoch } = await startBotlingd(dataDir);
    const botId = await addConfiguredProject(client, inc, originEpoch, project, "box", { n: 1 });
    const stream = `bot:${botId}`;

    const chatSlot: Slot = { origin: "script", originEpoch, target: stream, n: 2 };
    client.cmd(chatSlot, { type: "chat.send", botId, text: "/worker /slow" }, inc);
    expect((await client.wait(isResult(chatSlot), "chat.send result")).outcome.kind).toBe("applied");

    await until(
      () => client.entriesOf(stream).find((e) => e.kind === "turn.finished" && String((e.body as { text?: string }).text).includes("Handed off:")) ?? null,
      { timeout: 30_000, what: "initial handoff turn finished" },
    );

    const remoteStart = await until(
      () => readJsonLines(claudeLog).find((s) => isUnder(s.cwd, remoteReal)) ?? null,
      { timeout: 30_000, what: "remote fake-claude started" },
    );
    const remotePid = Number(remoteStart.pid);
    expect(Number.isInteger(remotePid) && remotePid > 0).toBe(true);

    process.kill(remotePid, "SIGKILL");

    const failedSubagent = await until(
      () =>
        client
          .entriesOf(stream)
          .find((e) => e.kind === "subagent.updated" && (e.body as { subagent: { status: string } }).subagent.status === "failed") ?? null,
      { timeout: 30_000, what: "failed subagent entry" },
    );
    const subagent = (failedSubagent.body as { subagent: { status: string; result: string | null } }).subagent;
    expect(subagent.status).toBe("failed");
    expect(subagent.result).toContain("The worker's process ended before its report");

    await until(
      () => client.entriesOf(stream).find((e) => e.kind === "turn.finished" && String((e.body as { text?: string }).text).includes("Worker failure noted.")) ?? null,
      { timeout: 30_000, what: "coordinator failure report turn finished" },
    );
    await until(() => (daemon.runningTurns().length === 0 ? true : null), { timeout: 10_000, what: "no running turns" });

    const taskResults = readJsonLines(inputLog).filter((line) => typeof line.text === "string" && line.text.startsWith("<app_task_result "));
    expect(taskResults).toHaveLength(1);
    expect(String(taskResults[0]!.text)).toContain('status="failed"');
    expect(String(taskResults[0]!.text)).toContain("The worker's process ended before its report");
    expect(daemon.runningTurns()).toEqual([]);
  }, 90_000);
});
