// URL tickets for the tailnet content path (M2 step 9, brief Q1, src/protocol/content-url.ts; M5-17 plugin binding).
//
// Why a ticket and not v1 §9A.4's `__Host-` cookie: the 2.x chat runs in a sandboxed, opaque-origin frame. The Q1 spike
// (.bot/artifacts/v3-m2/step-9-content.md) found, in headless Chromium and WebKit, that a `<video>` there sends no
// `SameSite=Strict` cookie in Chromium (it does in WebKit), and that no service worker controls the frame in either
// engine; a URL ticket loads in both (with `Cross-Origin-Resource-Policy: cross-origin` on the answer).
//
// A ticket is 32 random bytes (base64url), bound to (device, owner, content id, entry, plugin?), kept in memory only
// (never in a log, never on disk), and lives CONTENT_TICKET_TTL_MS. Asking again for the same binding while the session
// lives renews it under the same text, so a playing `<video>`'s URL never changes. It carries no claim of its own:
// every request re-checks the device in the roster, its `read` scope, the plugin's grant row on the owner (when
// plugin-bound), and the entry's reference (remote.ts).
import { randomBytes } from "node:crypto";
import { CONTENT_TICKET_TTL_MS, type ContentTicketGrant, type EntryRef } from "../../protocol";
import { PluginRow } from "../../protocol/table-rows";
import { readRowBody } from "../replica/tables";
import { pluginApproved } from "../slots/grant-check";
import type { Db } from "../store";

/** The most tickets kept at once (the oldest go first); a phone showing a long chat holds a few hundred. */
export const TICKETS_LIMIT = 20_000;

export interface TicketBinding { deviceId: string; owner: string; id: string; entry: EntryRef; plugin?: string }

const bindingKey = (b: TicketBinding) => `${b.deviceId}\n${b.owner}\n${b.id}\n${b.entry.stream}\n${b.entry.seq}\n${b.plugin ?? ""}`;

/**
 * Checks that `plugin` may read `owner`'s content (§9A.7, C7, D54, M5-17). The running code is this server's own copy
 * (`srv:<self>`, the one a front end loads, D52). Since the trust model of 2026-11-16 the approval belongs to the plugin,
 * not to a code hash: both this server's row and `srv:<owner>`'s row must be installed (`pluginApproved`; for the server's
 * own content the owner is `self`), whatever their hashes. A missing, tombstoned, malformed or not installed row, and any
 * read error, is refused (fail closed).
 */
export function hasPluginReadGrant(db: Db, self: string, owner: string, plugin: string): boolean {
  try {
    const key = `plugin:${plugin}`;
    const running = PluginRow.safeParse(readRowBody(db, `srv:${self}`, key));
    if (!running.success) return false;
    let granting = running.data;
    if (owner !== self) {
      const theirs = PluginRow.safeParse(readRowBody(db, `srv:${owner}`, key));
      if (!theirs.success) return false;
      granting = theirs.data;
    }
    // Both copies must be installed: the code running here (this server's row) and the owner's own copy of the plugin.
    return pluginApproved(running.data) && pluginApproved(granting);
  } catch {
    return false;
  }
}

export class ContentTickets {
  private readonly byTicket = new Map<string, ContentTicketGrant>();
  private readonly byBinding = new Map<string, string>();

  constructor(private readonly options: { now?: () => number; ttlMs?: number; limit?: number } = {}) {}

  private now(): number { return this.options.now?.() ?? Date.now(); }
  get size(): number { return this.byTicket.size; }

  /** A ticket for the binding: the one already given (renewed), or a new one. */
  issue(binding: TicketBinding): { ticket: string; expiresAt: number } {
    const now = this.now();
    const expiresAt = now + (this.options.ttlMs ?? CONTENT_TICKET_TTL_MS);
    const key = bindingKey(binding);
    const known = this.byBinding.get(key);
    const grant = known ? this.byTicket.get(known) : undefined;
    if (grant && grant.expiresAt > now) {
      // Renewed: moved to the newest end of the map (the oldest are dropped first).
      this.byTicket.delete(grant.ticket);
      grant.expiresAt = expiresAt;
      this.byTicket.set(grant.ticket, grant);
      return { ticket: grant.ticket, expiresAt };
    }
    if (known) this.drop(known);
    this.sweep(now);
    const ticket = randomBytes(32).toString("base64url");
    this.byTicket.set(ticket, {
      ticket,
      deviceId: binding.deviceId,
      owner: binding.owner,
      id: binding.id,
      entry: { ...binding.entry },
      expiresAt,
      ...(binding.plugin !== undefined ? { plugin: binding.plugin } : {}),
    });
    this.byBinding.set(key, ticket);
    const limit = this.options.limit ?? TICKETS_LIMIT;
    while (this.byTicket.size > limit) this.drop(this.byTicket.keys().next().value!);
    return { ticket, expiresAt };
  }

  /** The grant of a ticket that is known and unexpired; null otherwise (an expired one is forgotten). */
  check(ticket: string): ContentTicketGrant | null {
    const grant = this.byTicket.get(ticket);
    if (!grant) return null;
    if (grant.expiresAt <= this.now()) { this.drop(ticket); return null; }
    return grant;
  }

  /** Forgets every ticket of a device (revoked, removed). */
  dropDevice(deviceId: string): number {
    let dropped = 0;
    for (const [ticket, grant] of [...this.byTicket]) if (grant.deviceId === deviceId) { this.drop(ticket); dropped += 1; }
    return dropped;
  }

  clear(): void { this.byTicket.clear(); this.byBinding.clear(); }

  private drop(ticket: string): void {
    const grant = this.byTicket.get(ticket);
    this.byTicket.delete(ticket);
    if (grant && this.byBinding.get(bindingKey(grant)) === ticket) this.byBinding.delete(bindingKey(grant));
  }

  private sweep(now: number): void {
    for (const [ticket, grant] of this.byTicket) {
      if (grant.expiresAt <= now) this.drop(ticket);
    }
  }
}
