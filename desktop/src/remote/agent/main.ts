// `botling-agent`: runs Botling's Claude workers on this machine (multi-machine phase 1, docs/remote-workers.md).
// Plain Node 18+, no Electron. Installed by Botling under ~/.botling-agent:
//   botling-agent serve      frames on stdio (Botling runs it over ssh, one process per connection)
//   botling-agent version    prints {"version", "sha", "protocol"}
//   botling-agent info       prints what Botling checks: node, git, claude
//   botling-agent pair <code> [--name N]   pairs this machine with Botling over the relay (the install line runs it)
//   botling-agent relay      keeps this machine connected to Botling over the relay (the daemon)
//   botling-agent install    installs this bundle and its launcher under ~/.botling-agent (the install script)
import { createHash, webcrypto } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { openSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ClaudeHead } from "../../core/agent/head";
import { AGENT_HOME_DIR, AGENT_PROTOCOL, APP_VERSION, LineReader, parseFrame } from "../protocol";
import { AgentServer, machineConfig, pidAlive, type AgentLink } from "./server";
import { AgentRelay, pairMachine, relayLock } from "../relay/agent";
import { gitRpc } from "./git";
import { agentUpgrader, installBundle } from "./install";

// Node 18 has WebCrypto only as node:crypto's webcrypto (globalThis.crypto came in Node 19); the relay path's
// end-to-end encryption (mobile-relay/e2e.ts) uses globalThis.crypto.
if (!(globalThis as { crypto?: unknown }).crypto) Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true, writable: true });

export const agentHome = () => process.env.BOTLING_AGENT_HOME?.trim() || join(homedir(), AGENT_HOME_DIR);

/** The SHA-256 of this agent's own bundle (empty when it cannot be read, e.g. under a test runner). */
export function ownSha(file = typeof __filename === "string" ? __filename : ""): string {
  try { return createHash("sha256").update(readFileSync(file)).digest("hex"); } catch { return ""; }
}

const run = (command: string, args: string[]) => new Promise<string | null>((resolve) => {
  execFile(command, args, { timeout: 15_000, encoding: "utf8", env: process.env }, (error, stdout) => resolve(error ? null : stdout.trim()));
});

/** What Botling checks before it hands this machine a worker. */
export async function machineInfo(home: string, sha: string) {
  const settings = agentSettings(home);
  const claude = process.env.BOTLING_AGENT_CLAUDE?.trim() || settings.claude || "claude";
  const [git, claudeVersion] = await Promise.all([run("git", ["--version"]), run(claude, [...(settings.claudeArgs ?? []), "--version"])]);
  return { version: APP_VERSION, sha, protocol: AGENT_PROTOCOL, node: process.version, platform: `${process.platform}-${process.arch}`, home, git, claude: claudeVersion };
}

export function agentRpc(home: string, sha: string, onUpgraded?: () => void) {
  const gitOps = gitRpc(home);
  const upgrade = agentUpgrader(home, sha);
  return async (op: string, args: Record<string, unknown>, link: AgentLink): Promise<unknown> => {
    if (op === "info") return machineInfo(home, sha);
    if (op === "upgrade") {
      const result = await upgrade(args);
      if (result.installed) onUpgraded?.();
      return result;
    }
    return gitOps(op, args, link);
  };
}

/**
 * <home>/config.json, the machine's own settings (optional): {"claude": "/path/to/claude", "claudeArgs": [...]} when
 * claude is not on the PATH a login shell gives.
 */
export function agentSettings(home: string): { claude?: string; claudeArgs?: string[] } {
  try {
    const raw = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    return {
      ...(typeof raw?.claude === "string" && raw.claude.trim() ? { claude: raw.claude.trim() } : {}),
      ...(Array.isArray(raw?.claudeArgs) && raw.claudeArgs.every((a: unknown) => typeof a === "string") ? { claudeArgs: raw.claudeArgs } : {}),
    };
  } catch { return {}; }
}

export function newAgentServer(home = agentHome(), sha = ownSha(), onUpgraded?: () => void) {
  const settings = agentSettings(home);
  return new AgentServer({
    home, version: APP_VERSION, sha,
    config: (spec) => machineConfig(spec, { command: settings.claude, args: settings.claudeArgs }),
    spawn: (config, handlers) => new ClaudeHead(config, handlers),
    rpc: agentRpc(home, sha, onUpgraded),
    log: (line) => process.stderr.write(`botling-agent: ${line}\n`),
  });
}

/** `serve`: one connection on stdio. When stdin ends the connection is over: claude stops, the process exits. */
export async function serve(): Promise<void> {
  const server = newAgentServer();
  const link = server.connect((frame) => { process.stdout.write(`${JSON.stringify(frame)}\n`); });
  const reader = new LineReader((line) => {
    const frame = parseFrame(line);
    if (frame) void link.recv(frame);
  });
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => reader.push(chunk));
  await new Promise<void>((resolve) => process.stdin.once("end", resolve).once("close", resolve));
  await link.closed();
  await server.close();
}

/**
 * `relay`: the daemon. One per machine; SIGTERM/SIGINT stop it (claude processes stop with their links). After an
 * upgrade it stops and the new version starts: systemd restarts it (Restart=always), otherwise it starts its own
 * replacement (which waits for this one's lock).
 */
export async function relayDaemon(): Promise<void> {
  const home = agentHome();
  let release = relayLock(home, pidAlive);
  for (let i = 0; !release && process.env.BOTLING_AGENT_WAIT_LOCK === "1" && i < 30; i++) {
    await new Promise((r) => setTimeout(r, 500));
    release = relayLock(home, pidAlive);
  }
  if (!release) { process.stderr.write("botling-agent: the relay daemon already runs on this machine\n"); process.exit(0); }
  let upgraded = false;
  let stop: () => void = () => {};
  const stopped = new Promise<void>((resolve) => { stop = resolve; process.once("SIGTERM", resolve); process.once("SIGINT", resolve); });
  const server = newAgentServer(home, ownSha(), () => {
    upgraded = true;
    process.stderr.write("botling-agent: upgraded; restarting\n");
    setTimeout(stop, 1_500); // the answer leaves first
  });
  const relay = new AgentRelay({ home, server, log: (line) => process.stderr.write(`botling-agent: ${line}\n`) });
  relay.start();
  await stopped;
  await relay.stop();
  await server.close();
  release();
  if (upgraded && !process.env.INVOCATION_ID) {
    const log = openSync(join(home, "relay.log"), "a", 0o600);
    spawn(join(home, "bin", "botling-agent"), ["relay"], { detached: true, stdio: ["ignore", log, log], env: { ...process.env, BOTLING_AGENT_WAIT_LOCK: "1" } }).unref();
  }
  process.exit(upgraded ? 75 : 0);
}

async function main(argv: string[]) {
  const [command] = argv;
  if (command === "pair") {
    const code = argv[1];
    if (!code) { process.stderr.write("usage: botling-agent pair <code> [--name NAME]\n"); process.exit(2); }
    const at = argv.indexOf("--name");
    await pairMachine({ home: agentHome(), offer: code, ...(at > 0 && argv[at + 1] ? { name: argv[at + 1] } : {}) });
    process.exit(0);
  }
  if (command === "relay") { await relayDaemon(); process.exit(0); }
  if (command === "install") {
    const self = typeof __filename === "string" ? __filename : "";
    installBundle(agentHome(), readFileSync(self));
    process.stdout.write(`${JSON.stringify({ installed: join(agentHome(), "bin", "botling-agent"), version: APP_VERSION, sha: ownSha() })}\n`);
    return;
  }
  if (command === "serve") { await serve(); process.exit(0); }
  if (command === "version") { process.stdout.write(`${JSON.stringify({ version: APP_VERSION, sha: ownSha(), protocol: AGENT_PROTOCOL })}\n`); return; }
  if (command === "info") { process.stdout.write(`${JSON.stringify(await machineInfo(agentHome(), ownSha()))}\n`); return; }
  process.stderr.write("usage: botling-agent serve | version | info | pair <code> | relay | install\n");
  process.exit(2);
}

if (require.main === module) {
  // Node 18 says X25519 is experimental; the warning is noise on stderr for every relay connection.
  process.removeAllListeners("warning");
  main(process.argv.slice(2)).catch((error) => { process.stderr.write(`botling-agent: ${(error as Error).message}\n`); process.exit(1); });
}
