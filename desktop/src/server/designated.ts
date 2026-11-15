// Botling 3 M5-04i: which server runs the cluster's main bot (D74 / Q-C4), read once at each server's start.
import type { RosterView } from "./roster/validity";

/**
 * The `designatedServer` pref when it names a server this server holds valid (a known server, not revoked, valid by
 * R6); otherwise the current root; with no cluster yet, this server. Fails closed: a non-string, a device, an unknown,
 * revoked or invalid member never designates.
 */
export function designatedServer(view: Pick<RosterView, "self" | "servers" | "valid" | "root">, raw: unknown): string {
  if (typeof raw === "string" && view.servers.has(raw) && view.valid.has(raw)) return raw;
  return view.root?.root ?? view.self;
}

/** A machine name as one line for a log or the terminal: control characters escaped, at most 200 characters. */
export function machineLabel(name: string): string {
  return JSON.stringify(name).slice(1, -1).replace(/\\"/g, "\"").slice(0, 200);
}
