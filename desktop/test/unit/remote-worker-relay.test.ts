// Remote workers over the relay (multi-machine phase 1, M2), without a network: the relay's own room logic
// (relay/src/relay.ts) joined to Botling's machines hub and to botling-agent's `pair` and daemon by in-memory sockets.
// Device-code pairing (name, fingerprint, the code typed in Botling), a worker run end to end on the machine with its
// approval card and its branch back, the channel lost and resumed, revoking, and that the relay carried ciphertext only.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ClaudeWorkers } from "../../src/core/agent/claude-workers";
import { ClaudeHead } from "../../src/core/agent/head";
import type { SocketLike } from "../../src/mobile-relay/connector";
import { AgentServer, machineConfig } from "../../src/remote/agent/server";
import { gitRpc } from "../../src/remote/agent/git";
import { APP_VERSION } from "../../src/remote/protocol";
import { AgentRelay, pairMachine, readRelayConfig } from "../../src/remote/relay/agent";
import { decodeOffer } from "../../src/remote/relay/wire";
import { MiniWebSocket } from "../../src/remote/relay/ws";
import { RemoteWorkers } from "../../src/remote/service";

const root = resolve(__dirname, "../..");
const fakeClaude = join(root, "test/fixtures/fake-claude.mjs");

interface RelayLike { attach(socket: { send(t: string): void; close(c: number, r: string): void }, ip: string): { message(t: string): void; closed(): void }; shutdown(): void; stats(): { rooms: number; peers: number } }
// relay/ is its own package (Node type stripping, `.ts` imports); load it at run time so tsc does not type-check it here.
const serverModule = new URL("../../../relay/src/server.ts", import.meta.url).href;
const relayModule = new URL("../../../relay/src/relay.ts", import.meta.url).href;
const configModule = new URL("../../../relay/src/config.ts", import.meta.url).href;
async function makeRelay(): Promise<RelayLike> {
  const { Relay } = await import(/* @vite-ignore */ relayModule);
  const { loadConfig } = await import(/* @vite-ignore */ configModule);
  return new Relay({ ...loadConfig({}), helloTimeoutSeconds: 5 });
}

const wire: string[] = [];
/** In-memory sockets into the relay, as connector tests do; `cut()` drops every socket opened so far (the network). */
function sockets(relay: RelayLike) {
  const open: (() => void)[] = [];
  const make = (_url: string): SocketLike => {
    let hungUp = false;
    const sock: SocketLike & { readyState: number } = {
      readyState: 0, onopen: null, onmessage: null, onclose: null, onerror: null,
      send(text: string) { wire.push(text); queueMicrotask(() => { if (sock.readyState === 1) handlers.message(text); }); },
      close() { if (sock.readyState === 3) return; sock.readyState = 3; hungUp = true; handlers.closed(); queueMicrotask(() => sock.onclose?.({ code: 1000 })); },
    };
    const handlers = relay.attach({
      send: (text) => { wire.push(text); queueMicrotask(() => { if (!hungUp) sock.onmessage?.({ data: text }); }); },
      close: (code) => { if (sock.readyState === 3) return; sock.readyState = 3; queueMicrotask(() => { hungUp = true; sock.onclose?.({ code }); }); },
    }, "127.0.0.1");
    open.push(() => { if (sock.readyState === 3) return; sock.readyState = 3; hungUp = true; handlers.closed(); queueMicrotask(() => sock.onclose?.({ code: 1006 })); });
    queueMicrotask(() => { sock.readyState = 1; sock.onopen?.({}); });
    return sock;
  };
  return Object.assign(make, { cut: () => { for (const c of open.splice(0)) c(); } });
}

function agentServer(home: string) {
  const git = gitRpc(home);
  return new AgentServer({
    home, version: APP_VERSION, sha: "",
    config: (spec) => machineConfig(spec),
    spawn: (config, handlers) => new ClaudeHead(config, handlers),
    rpc: async (op, args, link) => op === "info" ? { version: APP_VERSION, node: process.version, git: "git", claude: "fake" } : git(op, args, link),
  });
}

const until = async (what: string, check: () => boolean, ms = 20_000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

describe("remote worker over the relay", () => {
  const saved: Record<string, string | undefined> = {};
  const env = { BOTLING_AGENT_CLAUDE: process.execPath, BOTLING_AGENT_CLAUDE_ARGS: JSON.stringify([fakeClaude]), FAKE_CLAUDE_RUN_TOOLS: "1" };
  let dir: string;
  beforeAll(() => {
    for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }
    dir = mkdtempSync(join(tmpdir(), "botling-remote-relay-"));
  });
  afterAll(() => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    rmSync(dir, { recursive: true, force: true });
  });

  it("pairs with the code, runs a worker there, survives a lost channel, and revoking ends it", async () => {
    const relay = await makeRelay();
    const net = sockets(relay);
    const home = join(dir, "machine"), data = join(dir, "data"), project = join(dir, "project");
    mkdirSync(home, { recursive: true });
    mkdirSync(project, { recursive: true });
    git(project, "init", "-q", "-b", "main");
    git(project, "config", "user.name", "Test"); git(project, "config", "user.email", "test@example.invalid");
    writeFileSync(join(project, "README.md"), "hello\n");
    git(project, "add", "."); git(project, "commit", "-q", "-m", "first");
    const base = git(project, "rev-parse", "HEAD");
    const log = join(dir, "claude.log");
    process.env.FAKE_CLAUDE_LOG = log;

    const remote = new RemoteWorkers({ dataDir: data, bundle: join(root, "out/agent/botling-agent.cjs"), relayUrl: () => "ws://localhost/ws", relaySocket: net, waits: [50, 100, 200], relayWaitMs: 3_000 });
    let daemon: AgentRelay | null = null;
    let server: AgentServer | null = null;
    let workers: ClaudeWorkers | null = null;
    try {
      // Pair: the offer goes to the machine in the install line.
      const { offer, command } = await remote.pairRelay();
      expect(command).toMatch(/^curl -fsSL https:\/\/github\.com\/.+\/botling-agent-install\.sh \| sh -s -- 'botling-machine1\./);
      expect(decodeOffer(offer).u).toBe("ws://localhost/ws");
      await until("Botling on the relay", () => remote.relay.state === "online");

      const printed: string[] = [];
      const paired = pairMachine({ home, offer, name: "gpu box", socket: net, print: (l) => printed.push(l) });
      await until("the request in Settings › Machines", () => remote.machines.list().some((m) => m.via === "relay") && printed.some((l) => l.includes("Code:")));
      const asked = remote.machines.list().find((m) => m.via === "relay")!;
      expect(asked).toMatchObject({ name: "gpu-box", trust: "asked" });
      const code = /Code:\s+(\S+)/.exec(printed.join("\n"))![1]!;
      expect(printed.join("\n")).toContain(asked.relay!.fingerprint.slice(0, 4));
      expect(code).toMatch(/^[2-9A-Z]{4}-[2-9A-Z]{4}$/);
      // A second machine with the same line is refused: an offer pairs one machine.
      await expect(pairMachine({ home: join(dir, "other"), offer, socket: net, print: () => {} })).rejects.toThrow(/used already|expired|refused/);
      // A wrong code is refused and the request stays; the right one approves.
      await expect(remote.approveRelay(asked.id, "AAAA-AAAA")).rejects.toThrow(/does not match/);
      const approved = await remote.approveRelay(asked.id, code.toLowerCase());
      expect(approved.trust).toBe("trusted");
      const config = await paired;
      expect(config.token).toBeTruthy();
      expect(readRelayConfig(home)?.id).toBe(asked.relay!.fingerprint);

      // The daemon connects with its token.
      server = agentServer(home);
      daemon = new AgentRelay({ home, server, socket: net, waits: [50, 100, 200] });
      daemon.start();
      await until("the machine's channel", () => remote.relay.connected(asked.id));
      const info = await remote.check(asked.id);
      expect(info).toMatchObject({ node: process.version });

      // A worker on the machine, as over ssh.
      const items: any[] = [], reports: { id: string; text: string }[] = [];
      workers = new ClaudeWorkers({
        file: join(dir, "claude-workers.json"), ownerSessionId: () => "coordinator", base: () => ({ command: "claude", cwd: project, sessionId: "c", resume: true, allowedTools: [] }), cwd: () => project,
        subagentModel: () => null, settleMs: 5, keepAliveMs: 60_000, home: join(dir, "home"), remote: () => remote,
      }, (item) => items.push(item), (id, text) => { reports.push({ id, text }); return true; }, () => { throw new Error("no local process for a remote worker"); });
      const started = await workers.tool("app_handoff", { instructions: "/tool echo relay > relay.txt", name: "Relay job", machine: "gpu-box" }) as { task_id: string };
      await until("the approval card", () => items.some((i) => i.kind === "permission"), 30_000);
      const card = items.find((i) => i.kind === "permission");
      expect(card).toMatchObject({ tool: "Bash", input: { command: "echo relay > relay.txt" } });

      expect(workers.answer(card.requestId, true, card.input)).toBe(true);
      await until("the report", () => reports.length > 0, 30_000);
      const branch = /on branch (\S+) here/.exec(reports[0]!.text)?.[1];
      expect(branch).toMatch(/^bot\/remote-relay-job-/);
      expect(git(project, "show", `${branch}:relay.txt`)).toBe("relay");
      expect(git(project, "rev-parse", `${branch}^`)).toBe(base);

      // A second worker; the network drops (every socket): it is interrupted, both sides reconnect, and it resumes
      // on its session; the answer to the lost run's card is refused, and the card says so.
      const second = await workers.tool("app_handoff", { instructions: "/tool echo two", name: "Lossy", machine: "gpu-box" }) as { task_id: string };
      await until("its card", () => items.filter((i) => i.kind === "permission").length === 2, 30_000);
      const card2 = items.filter((i) => i.kind === "permission").at(-1);
      const session = remote.session(second.task_id)!;
      net.cut();
      await until("the cut", () => session.w === "interrupted" || session.gen > 1, 10_000);
      await until("the resumed run", () => session.conn === "up" && session.w === "running" && session.gen >= 2, 30_000);
      expect(workers.answer(card2.requestId, true, card2.input)).toBe(true);
      await until("the card again", () => items.filter((i) => i.kind === "permission").length > 2, 5_000);
      expect(items.filter((i) => i.kind === "permission").at(-1).summary).toMatch(/^Your answer (was not sent|did not reach)/);
      await until("its report", () => reports.length > 1, 30_000);
      const starts = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((s) => s.session === JSON.parse(readFileSync(log, "utf8").trim().split("\n").at(-1)!).session);
      expect(starts.length).toBe(2);
      expect(starts[1].resume).toBe(true);

      // Revoke: the relay closes the machine's connection now; it cannot come back; new work is refused.
      remote.revoke(asked.id);
      await until("the daemon refused", () => daemon!.state === "revoked", 10_000);
      expect(remote.relay.connected(asked.id)).toBe(false);
      await expect(workers.tool("app_handoff", { instructions: "x", name: "After", machine: "gpu-box" })).rejects.toThrow(/revoked/);

      // The relay saw only ciphertext: no frame names, paths or commands crossed it in the clear.
      const clear = wire.join("\n");
      expect(clear).not.toContain("relay.txt");
      expect(clear).not.toContain("echo relay");
      expect(clear).not.toContain('"t":"start"');
      // The relay sees the tokens' joins (it checks their hashes), never the pairing secret the install line carries.
      expect(clear).not.toContain(decodeOffer(offer).s);
      expect(existsSync(join(home, "sessions", started.task_id, "log.jsonl"))).toBe(true);
    } finally {
      delete process.env.FAKE_CLAUDE_LOG;
      await workers?.close();
      await daemon?.stop();
      await server?.close();
      remote.close();
      relay.shutdown();
    }
  }, 120_000);

  it("a declined, expired or wrong-coded pairing leaves nothing trusted", async () => {
    const relay = await makeRelay();
    const net = sockets(relay);
    const remote = new RemoteWorkers({ dataDir: join(dir, "data-2"), bundle: "", relayUrl: () => "ws://localhost/ws", relaySocket: net });
    try {
      // Declined: the machine is told so.
      const first = await remote.pairRelay();
      const printed: string[] = [];
      const declined = pairMachine({ home: join(dir, "m-1"), offer: first.offer, name: "one", socket: net, print: (l) => printed.push(l) });
      await until("the request", () => printed.some((l) => l.includes("Code:")));
      const one = remote.machines.find("one")!;
      await remote.decline(one.id);
      await expect(declined).rejects.toThrow(/declined/);
      expect(remote.machines.find("one")).toBeUndefined();

      // Wrong code three times: declined.
      const second = await remote.pairRelay();
      const out2: string[] = [];
      const wrong = pairMachine({ home: join(dir, "m-2"), offer: second.offer, name: "two", socket: net, print: (l) => out2.push(l) });
      await until("the request", () => out2.some((l) => l.includes("Code:")));
      const two = remote.machines.find("two")!;
      await expect(remote.approveRelay(two.id, "2222-2222")).rejects.toThrow(/does not match/);
      await expect(remote.approveRelay(two.id, "3333-3333")).rejects.toThrow(/does not match/);
      await expect(remote.approveRelay(two.id, "4444-4444")).rejects.toThrow(/three times/);
      await expect(wrong).rejects.toThrow(/declined/);
      expect(remote.machines.find("two")).toBeUndefined();

      // An expired code is refused on the machine before anything is sent.
      const stale = await remote.pairRelay();
      await expect(pairMachine({ home: join(dir, "m-3"), offer: stale.offer, socket: net, now: () => Date.now() + 11 * 60_000 })).rejects.toThrow(/expired/);
      expect(remote.machines.list().filter((m) => m.trust === "trusted")).toEqual([]);
    } finally {
      remote.close();
      relay.shutdown();
    }
  }, 60_000);

  it("pairs and connects over a real relay server with botling-agent's own WebSocket client (Node 18 has none)", async () => {
    const { startRelay } = await import(/* @vite-ignore */ serverModule);
    const { loadConfig } = await import(/* @vite-ignore */ configModule);
    const server = await startRelay({ ...loadConfig({}), host: "127.0.0.1", port: 0 });
    const url = `ws://127.0.0.1:${server.port}/ws`;
    const mini = (u: string) => new MiniWebSocket(u);
    const home = join(dir, "machine-3");
    const remote = new RemoteWorkers({ dataDir: join(dir, "data-3"), bundle: "", relayUrl: () => url, relaySocket: mini });
    const agent = agentServer(home);
    const daemon = new AgentRelay({ home, server: agent, socket: mini, waits: [50, 100, 200] });
    try {
      const { offer } = await remote.pairRelay();
      await until("Botling on the relay", () => remote.relay.state === "online", 10_000);
      const printed: string[] = [];
      const paired = pairMachine({ home, offer, name: "real", socket: mini, print: (l) => printed.push(l) });
      await until("the code", () => printed.some((l) => l.includes("Code:")), 10_000);
      const code = /Code:\s+(\S+)/.exec(printed.join("\n"))![1]!;
      const machine = await remote.approveRelay(remote.machines.find("real")!.id, code);
      await paired;
      daemon.start();
      await until("the machine's channel", () => remote.relay.connected(machine.id), 10_000);
      expect(await remote.check(machine.id)).toMatchObject({ node: process.version });
      remote.revoke(machine.id);
      await until("the daemon refused", () => daemon.state === "revoked", 10_000);
    } finally {
      await daemon.stop();
      await agent.close();
      remote.close();
      await server.close();
    }
  }, 60_000);
});
