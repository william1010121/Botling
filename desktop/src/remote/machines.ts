// The machines Botling may run workers on (Settings › Machines), kept in <data>/remote/machines.json (0600):
// the model's `via`, `trust` and `epoch` per machine (spec/models/remoteworker/RemoteWorker.tla).
//   ssh:   a host from ~/.ssh/config; trust is its host key: the user approves the key Botling shows (Pair, Approve).
//   relay: a machine whose agent dials out to the relay; trust is its approved pairing (device code, its key).
// Each approval and each revoke makes a new epoch: a connection opened under an older one is ended (RevokeEnds).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export type MachinePath = "ssh" | "relay";
export type MachineTrust = "asked" | "trusted" | "revoked";

export interface Machine {
  id: string;
  /** The name shown (and that app_handoff's `machine` takes): the ssh alias, or the relay machine's own name. */
  name: string;
  via: MachinePath;
  trust: MachineTrust;
  epoch: number;
  addedAt: number;
  /** ssh: the alias in ~/.ssh/config. */
  host?: string;
  /** ssh: the host key shown and approved ("SHA256:…"), and its known_hosts lines (kept in Botling's own file). */
  hostKey?: { fingerprint: string; lines: string[]; known: boolean };
  /** relay: the agent's static public key, its fingerprint, and the hash of the token it joins with. */
  relay?: { publicKey: string; fingerprint: string; tokenHash: string | null; expiresAt?: number };
  /** The last machine check (node, git, claude) and when. */
  info?: { node?: string; git?: string | null; claude?: string | null; platform?: string; at: number; error?: string };
}

export type MachineChange = "added" | "approved" | "revoked" | "removed" | "updated";

export const MACHINE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,63}$/;

export class MachineStore {
  private machines: Machine[] = [];
  private listeners = new Set<(machine: Machine, change: MachineChange) => void>();
  constructor(readonly file: string) { this.load(); }

  static in(dataDir: string) { return new MachineStore(join(dataDir, "remote", "machines.json")); }

  private load() {
    try { const raw = JSON.parse(readFileSync(this.file, "utf8")); if (Array.isArray(raw?.machines)) this.machines = raw.machines; } catch { this.machines = []; }
  }
  private save() {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ machines: this.machines }, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
  private emit(machine: Machine, change: MachineChange) {
    for (const listener of this.listeners) { try { listener(machine, change); } catch { /* a listener's problem */ } }
  }
  onChange(listener: (machine: Machine, change: MachineChange) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }

  list(): Machine[] { return this.machines.map((m) => structuredClone(m)); }
  get(id: string): Machine | undefined { return this.machines.find((m) => m.id === id); }
  /** By id or by name (app_handoff's `machine`). */
  find(idOrName: string): Machine | undefined {
    const wanted = idOrName.trim();
    return this.machines.find((m) => m.id === wanted) ?? this.machines.find((m) => m.name.toLowerCase() === wanted.toLowerCase());
  }

  /** Pair: a machine asked for (ssh: its host key shown; relay: a device code waiting). */
  add(machine: Omit<Machine, "id" | "trust" | "epoch" | "addedAt"> & { id?: string }): Machine {
    if (!MACHINE_NAME.test(machine.name)) throw new Error("A machine name is letters, digits and . _ - @ (up to 64).");
    const other = this.machines.find((m) => m.name.toLowerCase() === machine.name.toLowerCase());
    if (other && other.trust !== "revoked") throw new Error(`There is already a machine named ${machine.name}.`);
    if (other) this.machines = this.machines.filter((m) => m !== other);
    const added: Machine = { ...machine, id: machine.id ?? other?.id ?? randomUUID(), trust: "asked", epoch: other?.epoch ?? 0, addedAt: Date.now() };
    this.machines.push(added);
    this.save();
    this.emit(added, "added");
    return structuredClone(added);
  }

  /** Approve: the user accepts the host key / the device code: a new credential. */
  approve(id: string, patch: Partial<Machine> = {}): Machine {
    const machine = this.get(id);
    if (!machine || machine.trust !== "asked") throw new Error("That machine is not waiting for approval.");
    Object.assign(machine, patch, { trust: "trusted", epoch: machine.epoch + 1 });
    this.save();
    this.emit(machine, "approved");
    return structuredClone(machine);
  }

  /** Decline or expire a machine that was asked for: it is forgotten. */
  decline(id: string): boolean {
    const machine = this.get(id);
    if (!machine || machine.trust !== "asked") return false;
    this.machines = this.machines.filter((m) => m !== machine);
    this.save();
    this.emit(machine, "removed");
    return true;
  }

  /** Revoke: its credential is void and every connection to it ends now. */
  revoke(id: string): boolean {
    const machine = this.get(id);
    if (!machine || machine.trust !== "trusted") return false;
    machine.trust = "revoked";
    machine.epoch += 1;
    if (machine.relay) machine.relay.tokenHash = null;
    this.save();
    this.emit(machine, "revoked");
    return true;
  }

  /** Removes a machine that is not trusted (revoked or asked). */
  remove(id: string): boolean {
    const machine = this.get(id);
    if (!machine || machine.trust === "trusted") return false;
    this.machines = this.machines.filter((m) => m !== machine);
    this.save();
    this.emit(machine, "removed");
    return true;
  }

  update(id: string, patch: Partial<Pick<Machine, "info" | "relay" | "hostKey">>) {
    const machine = this.get(id);
    if (!machine) return;
    Object.assign(machine, patch);
    this.save();
    this.emit(machine, "updated");
  }

  exists() { return existsSync(this.file); }
}
