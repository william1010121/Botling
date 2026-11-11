// Remote workers in the core (multi-machine phase 1): the machines (MachineStore), one transport per machine, and a
// RemoteSession per worker that runs on one. The Claude worker adapter asks it for a head when a worker was handed to a
// machine (app_handoff's `machine`); Settings › Machines adds, approves and revokes machines through it.
//   <data>/remote/machines.json     the machines and their trust
//   <data>/remote/known_hosts       the approved ssh host keys (Botling's own; ~/.ssh/known_hosts is not touched)
//   <data>/remote/sessions.json     each remote worker's session: its machine, connection number, last event, base
//   <data>/remote/relay.json        the machines room on the relay (relay/hub.ts)
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { HeadConfig, HeadHandlers } from "../core/agent/head";
import type { ClaudeWorkerHead } from "../core/agent/claude-workers";
import { APP_VERSION, validSession } from "./protocol";
import { MachineStore, type Machine } from "./machines";
import { RemoteSession, type SessionState, type SessionTransport } from "./session";
import { RemoteClaudeHead } from "./head";
import { RemoteGit } from "./git-sync";
import { SshTransport, fileSha, scanHostKey, shq, sshConfigHosts, writeKnownHosts } from "./ssh";
import { MachineRelay, RelayTransport } from "./relay/hub";
import { RelayStore } from "../mobile-relay/store";
import type { SocketLike } from "../mobile-relay/connector";

interface SavedSession extends SessionState { machine: string; base?: string | null }

export interface RemoteWorkersOptions {
  dataDir: string;
  /** The agent bundle the ssh path uploads (out/agent/botling-agent.cjs). */
  bundle: string;
  /** The ssh program (tests: a fake). */
  ssh?: string;
  /** Transports by machine, for tests. */
  transport?(machine: Machine): SessionTransport | null;
  /** The relay address for machines (default: Settings › Phone's relay, or BOTLING_MACHINE_RELAY). */
  relayUrl?(): string | null;
  /** The relay WebSocket (tests: in memory). */
  relaySocket?(url: string): SocketLike;
  /** How long a relay connection waits for the machine's agent. */
  relayWaitMs?: number;
  waits?: number[];
  log?(line: string): void;
}

/** What a worker row shows of its machine. */
export interface RemoteWorkerStatus { machine: string; conn: string; state: string; error: string | null }

export class RemoteWorkers {
  readonly machines: MachineStore;
  readonly knownHosts: string;
  private readonly sessionsFile: string;
  private saved: Record<string, SavedSession>;
  private transports = new Map<string, { epoch: number; transport: SessionTransport }>();
  private live = new Map<string, RemoteSession>();
  private sha: string | null = null;
  private listeners = new Set<() => void>();
  readonly relay: MachineRelay;

  constructor(readonly options: RemoteWorkersOptions) {
    this.machines = MachineStore.in(options.dataDir);
    const phoneRelay = new RelayStore(join(options.dataDir, "mobile"));
    this.relay = new MachineRelay({
      dir: join(options.dataDir, "remote"), machines: this.machines, log: options.log,
      url: options.relayUrl ?? (() => process.env.BOTLING_MACHINE_RELAY?.trim() || phoneRelay.url()),
      ...(options.relaySocket ? { socket: options.relaySocket } : {}),
      ...(options.relayWaitMs ? { channelWaitMs: options.relayWaitMs } : {}),
    });
    this.relay.onChange(() => this.changed());
    this.knownHosts = join(options.dataDir, "remote", "known_hosts");
    this.sessionsFile = join(options.dataDir, "remote", "sessions.json");
    try { this.saved = JSON.parse(readFileSync(this.sessionsFile, "utf8")).sessions ?? {}; } catch { this.saved = {}; }
    this.syncKnownHosts();
    this.relay.sync();
    this.machines.onChange((machine, change) => {
      if (change === "revoked" || change === "removed" || change === "approved") {
        this.transports.delete(machine.id);
        this.syncKnownHosts();
      }
      // RevokeEnds: every connection opened under the old credential ends now.
      if (change === "revoked") for (const session of this.live.values()) if (this.saved[session.id]?.machine === machine.id) session.revoked();
      if (change === "approved") for (const session of this.live.values()) if (this.saved[session.id]?.machine === machine.id) session.wake();
      this.changed();
    });
  }

  onChange(listener: () => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private changed() { for (const l of this.listeners) { try { l(); } catch { /* a listener's problem */ } } }

  private persist() {
    mkdirSync(dirname(this.sessionsFile), { recursive: true, mode: 0o700 });
    const tmp = `${this.sessionsFile}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ sessions: this.saved }), { mode: 0o600 });
    renameSync(tmp, this.sessionsFile);
  }

  private syncKnownHosts() {
    const trusted = this.machines.list().filter((m) => m.via === "ssh" && m.trust === "trusted" && m.hostKey);
    try { writeKnownHosts(this.knownHosts, trusted.map((m) => ({ id: m.id, keys: m.hostKey!.lines }))); } catch (error) { this.options.log?.(`remote: could not write known_hosts: ${(error as Error).message}`); }
  }

  private agentSha() { return this.sha ??= fileSha(this.options.bundle); }

  /** The machine app_handoff's `machine` names: a trusted one, or why not. */
  resolve(name: string): { id: string; name: string } | { error: string } {
    const machine = this.machines.find(name);
    const names = this.machines.list().filter((m) => m.trust === "trusted").map((m) => m.name);
    if (!machine) return { error: `No machine named "${name}". ${names.length ? `Machines: ${names.join(", ")}.` : "No machines are set up: the user adds them in Settings › Machines."} Nothing was started.` };
    if (machine.trust !== "trusted") return { error: `The machine ${machine.name} is ${machine.trust === "revoked" ? "revoked" : "not approved yet"}. Nothing was started.` };
    return { id: machine.id, name: machine.name };
  }

  machineName(id: string) { return this.machines.get(id)?.name ?? id; }

  private transport(machine: Machine): SessionTransport {
    const held = this.transports.get(machine.id);
    if (held && held.epoch === machine.epoch) return held.transport;
    const transport = this.options.transport?.(machine) ?? (machine.via === "ssh" && machine.host
      ? new SshTransport({ machine: { id: machine.id, host: machine.host }, knownHosts: this.knownHosts, bundle: this.options.bundle, ssh: this.options.ssh, log: this.options.log })
      : machine.via === "relay" ? new RelayTransport(this.relay, { id: machine.id, name: () => this.machineName(machine.id) })
        : null);
    if (!transport) throw new Error(`Botling cannot reach ${machine.name} this way yet.`);
    this.transports.set(machine.id, { epoch: machine.epoch, transport });
    return transport;
  }

  /** A head for a worker handed to a machine: the adapter uses it like a local ClaudeHead. */
  head(machineId: string, worker: { id: string; name: string }, cwd: string, config: HeadConfig, handlers: HeadHandlers): ClaudeWorkerHead {
    if (!validSession(worker.id)) throw new Error(`This worker's id cannot be used on another machine (${worker.id}).`);
    const machine = this.machines.get(machineId);
    if (!machine) throw new Error("The machine this worker was handed to is no longer in Settings › Machines.");
    const saved = this.saved[worker.id];
    const state: SavedSession = saved?.machine === machineId ? saved : { machine: machineId, gen: 0, got: 0, sweep: false, started: false };
    this.saved[worker.id] = state;
    this.live.get(worker.id)?.close();
    const git = new RemoteGit({
      cwd, machine: machineId, worker: worker.id, name: worker.name, base: state.base ?? null,
      saveBase: (base) => { state.base = base; this.persist(); },
    });
    return new RemoteClaudeHead({
      config, handlers, git, log: this.options.log,
      session: (events) => {
        const session = new RemoteSession({
          id: worker.id, auto: true, waits: this.options.waits,
          machine: {
            trusted: () => this.machines.get(machineId)?.trust === "trusted",
            epoch: () => this.machines.get(machineId)?.epoch ?? 0,
            name: () => this.machineName(machineId),
          },
          transport: this.transport(machine),
          version: () => APP_VERSION,
          sha: () => (this.machines.get(machineId)?.via === "ssh" ? this.agentSha() : ""),
          state,
          save: (next) => { Object.assign(state, next); this.persist(); },
          events: { ...events, changed: () => this.changed() },
          prepare: (link) => git.prepare(link),
          log: this.options.log,
        });
        this.live.set(worker.id, session);
        return session;
      },
    });
  }

  /** The live session of a worker (tests, diagnostics). */
  session(workerId: string): RemoteSession | undefined { return this.live.get(workerId); }

  /** What the worker row shows (null: not a remote worker). */
  status(workerId: string): RemoteWorkerStatus | null {
    const saved = this.saved[workerId];
    if (!saved) return null;
    const session = this.live.get(workerId);
    return { machine: this.machineName(saved.machine), conn: session?.conn ?? "down", state: session?.w ?? "none", error: session?.lastError ?? null };
  }

  // ---- Settings › Machines.

  sshHosts(): string[] { return sshConfigHosts(); }

  /** Pair (ssh): reads the host's key; the user approves its fingerprint next. */
  async addSsh(host: string, name = host): Promise<Machine> {
    if (!/^[A-Za-z0-9_.@:[\]-]{1,255}$/.test(host)) throw new Error("That is not an ssh host name.");
    const key = await scanHostKey(host);
    return this.machines.add({ name, via: "ssh", host, hostKey: { fingerprint: key.fingerprint, lines: key.lines, known: key.known } });
  }

  /** Approve (ssh): the key is written to Botling's known_hosts; the machine is checked (and the agent installed). */
  async approveSsh(id: string): Promise<Machine> {
    const machine = this.machines.approve(id);
    try { await this.check(machine.id); } catch { /* the check says what is wrong; the machine stays approved */ }
    return this.machines.get(machine.id)!;
  }

  /** Checks a machine: node, git, claude (ssh: installs or updates the agent first when needed). */
  async check(id: string) {
    const machine = this.machines.get(id);
    if (!machine || machine.trust !== "trusted") throw new Error("That machine is not approved.");
    const transport = this.transport(machine);
    if (!(transport instanceof SshTransport) && !(transport instanceof RelayTransport)) throw new Error("This machine cannot be checked.");
    try {
      let info: Record<string, unknown>;
      if (transport instanceof SshTransport) {
        try { info = await transport.info(); } catch { await transport.upgrade(); info = await transport.info(); }
        if (info.version !== APP_VERSION || info.sha !== this.agentSha()) { await transport.upgrade(); info = await transport.info(); }
      } else {
        info = await transport.info();
        if (info.version !== APP_VERSION) { await transport.upgrade(); info = await transport.info(); }
      }
      this.machines.update(id, { info: { node: String(info.node ?? ""), git: (info.git as string) ?? null, claude: (info.claude as string) ?? null, platform: String(info.platform ?? ""), at: Date.now() } });
      return info;
    } catch (error) {
      this.machines.update(id, { info: { at: Date.now(), error: (error as Error).message } });
      throw error;
    }
  }

  /**
   * Pair (relay): a one-time offer and the line to run on the machine. The machine then shows its name, fingerprint
   * and a code; it is listed here as asked, and approveRelay takes the code.
   */
  async pairRelay(): Promise<{ offer: string; command: string; expiresAt: number }> {
    const { offer, expiresAt } = await this.relay.offer();
    return { offer, command: installCommand(offer), expiresAt };
  }

  /** Approve (relay): the code the machine shows. Wrong three times: declined. */
  async approveRelay(id: string, code: string): Promise<Machine> {
    const machine = await this.relay.approve(id, code);
    void this.check(machine.id).catch(() => { /* shown in the machine's info */ });
    return machine;
  }

  /** Decline a machine that asked (relay: it is told so). */
  async decline(id: string) {
    const machine = this.machines.get(id);
    if (machine?.via === "relay") return this.relay.decline(id);
    return this.machines.decline(id);
  }

  revoke(id: string) { return this.machines.revoke(id); }
  remove(id: string) { return this.machines.remove(id) || this.machines.decline(id); }

  close() { for (const session of this.live.values()) session.close(); this.live.clear(); this.relay.stop(); }
}

/** Where the agent is released (milestone 3 builds the assets; nothing is published from here). */
export const AGENT_RELEASES = "https://github.com/william1010121/Botling/releases/download";

/**
 * The line the user runs on a relay machine: fetches the install script of this app's version from the release, which
 * downloads botling-agent, checks its signature and checksum, installs it under ~/.botling-agent, pairs and starts it.
 */
export function installCommand(offer: string, version = APP_VERSION): string {
  return `curl -fsSL ${AGENT_RELEASES}/v${version}/botling-agent-install.sh | sh -s -- ${shq(offer)}`;
}
