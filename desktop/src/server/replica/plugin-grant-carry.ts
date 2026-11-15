// A plugin update keeps its grant unless it asks for more (follow-up to M5-14d). A grant is still bound to one code hash
// (D52): what changes is that, when a plugin's code changes and the new hash has no grant yet, reconcile writes one there
// itself, carried from the newest grant of an older hash of the same plugin, as long as the new code asks for nothing
// the old code did not ask for. The carried grant is never above the old grant nor above the new asks, and an
// `audit:plugin-carry.<id>` row names both hashes.
//
// "Asks for more" (any one of these refuses the carry and the plugin needs Allow again):
//   - a higher tier (row manifest tier, which also rises when the plugin's data folder fills);
//   - a read or a request (command) the old code did not ask for;
//   - a 2.x permission (`ccb.permissions`: network, files, exec, bots, claude, …) the old code did not list;
//   - a new program part (`ccb.host`) or bot tools folder (`ccb.claude`) the old code did not have;
//   - a different source (built-in vs library vs where it was installed from, the catalog commit left out).
// Not more: version, description, views, commands, menus (`when.host` only says on which tabs a menu shows), settings,
// the web bundle and styles.
//
// What each hash asked is kept in server.db `meta` (`plugin.asks:<name>`, local to this server, never replicated), since
// the row keeps only the current hash's manifest. A grant made before this record existed (no record at all for the
// plugin) is checked once against the grant itself (tier, reads, requests), without the 2.x permissions it cannot know.
// Each new hash is decided once: a revoke after a carry stays revoked.
import { randomUUID } from "node:crypto";
import type { AuditRow, PluginGrant, PluginRow, Tier } from "../../protocol/table-rows";
import type { Db } from "../store";
import { putRow } from "./tables";

type PluginCommand = PluginRow["manifest"]["requests"][number];

/** What reconcile knows about a plugin's code beyond the row manifest (from its package.json and registry entry). */
export interface CarryFacts {
  /** `ccb.permissions`. */
  permissions: string[];
  /** The parts that run code or give bots tools: "host" (`ccb.host`), "claude" (`ccb.claude`). */
  parts: string[];
  /** "builtin", "library", or where it was installed from (sourceKey). */
  source: string;
}

interface AsksBasis extends CarryFacts {
  tier: Tier;
  reads: string[];
  requests: PluginCommand[];
}

interface CarryNote {
  from: string;
  at: number;
  /** Set when the carry was refused: what the new code asks for that the old code did not. */
  grew?: string[];
}

interface CarryRecord {
  hashes: Record<string, AsksBasis>;
  carry: Record<string, CarryNote>;
}

const RANK: Record<Tier, number> = { read: 1, request: 2, write: 3 };
const KEEP = 20;
const metaKey = (name: string) => `plugin.asks:${name}`;

/** The source a plugin's code comes from; the commit of a catalog folder page is left out, so an update keeps its source. */
export function sourceKey(builtIn: boolean, installedFrom: string | null): string {
  if (builtIn) return "builtin";
  if (!installedFrom) return "library";
  return installedFrom.replace(/\/tree\/[0-9a-f]{7,64}\//, "/tree/*/").slice(0, 2_000);
}

/** Facts of one registry plugin. */
export function carryFactsOf(plugin: { builtIn: boolean; installedFrom: string | null; manifest: { ccb?: { permissions?: string[]; host?: string; claude?: string } } }): CarryFacts {
  const ccb = plugin.manifest.ccb;
  return {
    permissions: [...new Set(ccb?.permissions ?? [])].map((item) => String(item).slice(0, 40)).slice(0, 20).sort(),
    parts: [...(ccb?.host ? ["host"] : []), ...(ccb?.claude ? ["claude"] : [])],
    source: sourceKey(plugin.builtIn, plugin.installedFrom),
  };
}

const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");

function validBasis(value: unknown): value is AsksBasis {
  if (!value || typeof value !== "object") return false;
  const b = value as Record<string, unknown>;
  return typeof b.source === "string" && typeof b.tier === "string" && Object.hasOwn(RANK, b.tier)
    && strings(b.reads) && strings(b.requests) && strings(b.permissions) && strings(b.parts);
}

/** null: no record yet; "corrupt": a record that does not read (no carry then, L-009). */
function readRecord(tx: Db, name: string): CarryRecord | null | "corrupt" {
  const row = tx.prepare("SELECT value FROM meta WHERE key = ?").get(metaKey(name));
  if (!row) return null;
  try {
    const parsed = JSON.parse(String(row.value)) as unknown;
    if (!parsed || typeof parsed !== "object") return "corrupt";
    const { hashes, carry } = parsed as { hashes?: unknown; carry?: unknown };
    if (!hashes || typeof hashes !== "object" || !carry || typeof carry !== "object") return "corrupt";
    const out: CarryRecord = { hashes: {}, carry: {} };
    for (const [hash, basis] of Object.entries(hashes)) {
      if (!validBasis(basis)) return "corrupt";
      out.hashes[hash] = basis;
    }
    for (const [hash, note] of Object.entries(carry)) {
      const n = note as Partial<CarryNote> | null;
      if (!n || typeof n.from !== "string" || typeof n.at !== "number" || (n.grew !== undefined && !strings(n.grew))) return "corrupt";
      out.carry[hash] = { from: n.from, at: n.at, ...(n.grew ? { grew: n.grew } : {}) };
    }
    return out;
  } catch {
    return "corrupt";
  }
}

const item = (text: string) => (/^[A-Za-z0-9._-]{1,60}$/.test(text) ? text : JSON.stringify(text.slice(0, 60)));

/** What `now` asks for that `before` did not (empty: nothing more). Permissions and parts only when both are known. */
function grewFrom(before: { tier: Tier; reads: readonly string[]; requests: readonly string[]; permissions?: readonly string[]; parts?: readonly string[]; source?: string }, now: AsksBasis): string[] {
  const grew: string[] = [];
  if (before.source !== undefined && before.source !== now.source) grew.push("another source");
  if (RANK[now.tier] > RANK[before.tier]) grew.push(`tier ${now.tier}`);
  for (const r of now.reads) if (!before.reads.includes(r)) grew.push(`read ${item(r)}`);
  if (now.tier !== "read") for (const r of now.requests) if (!before.requests.includes(r)) grew.push(`request ${item(r)}`);
  if (before.permissions) for (const p of now.permissions) if (!before.permissions.includes(p)) grew.push(`permission ${item(p)}`);
  if (before.parts) for (const p of now.parts) if (!before.parts.includes(p)) grew.push(`part ${p}`);
  return grew;
}

/**
 * Called by reconcilePluginRows for one non-built-in plugin before its row is written: may add a carried grant to
 * `grants` (in place) and writes the audit row and the meta record. Returns a log line when it decided something.
 */
export function carryPluginGrant(tx: Db, stream: string, input: {
  name: string;
  codeHash: string;
  manifest: PluginRow["manifest"];
  facts: CarryFacts;
  prevCodeHash: string | undefined;
  grants: Record<string, PluginGrant>;
  now: number;
  onWritten?: (key: string, rev: number) => void;
}): string | null {
  const record = readRecord(tx, input.name);
  if (record === "corrupt") return `plugin grant not carried: ${input.name} (its asks record does not read)`;
  const firstRecord = record === null;
  const rec: CarryRecord = record ?? { hashes: {}, carry: {} };
  const cur = input.codeHash;
  const now: AsksBasis = { ...input.facts, tier: input.manifest.tier, reads: [...input.manifest.reads], requests: [...input.manifest.requests] };
  let line: string | null = null;

  if (!Object.hasOwn(input.grants, cur) && !Object.hasOwn(rec.carry, cur)) {
    // The old grant: the previous hash's if it has one, else the newest; built-in grants never carry.
    const candidates = Object.entries(input.grants).filter(([hash, grant]) => hash !== cur && grant.grantedBy !== "builtin");
    const prev = input.prevCodeHash;
    const picked = (prev !== undefined && candidates.find(([hash]) => hash === prev))
      || candidates.sort(([, a], [, b]) => b.at - a.at)[0];
    if (picked) {
      const [from, grant] = picked;
      const basis = Object.hasOwn(rec.hashes, from) ? rec.hashes[from] : undefined;
      const grew = basis
        ? grewFrom(basis, now)
        : firstRecord
          ? grewFrom({ tier: grant.tier, reads: grant.reads, requests: grant.requests }, now)
          : ["what the old code asked is not known"];
      if (grew.length === 0) {
        const tier: Tier = RANK[grant.tier] <= RANK[now.tier] ? grant.tier : now.tier;
        input.grants[cur] = {
          tier,
          reads: grant.reads.filter((r) => now.reads.includes(r)),
          requests: tier === "read" ? [] : grant.requests.filter((r) => now.requests.includes(r)),
          grantedBy: grant.grantedBy,
          at: input.now,
        };
        rec.carry[cur] = { from, at: input.now };
        const audit: AuditRow = { act: "plugin.carry", at: input.now, name: input.name, hash: cur.slice(0, 80), reason: `carried from ${from.slice(0, 80)} at tier ${tier}` };
        const auditKey = `audit:plugin-carry.${randomUUID()}`;
        const rev = putRow(tx, stream, auditKey, audit);
        if (rev != null) input.onWritten?.(auditKey, rev);
        line = `plugin grant carried: ${input.name} ${from.slice(0, 8)} -> ${cur.slice(0, 8)} (tier ${tier})`;
      } else {
        rec.carry[cur] = { from, at: input.now, grew };
        line = `plugin grant not carried: ${input.name} ${from.slice(0, 8)} -> ${cur.slice(0, 8)} asks more (${grew.join(", ")})`;
      }
    }
  }

  rec.hashes[cur] = now;
  // Keep the asks of the current hash and of hashes with a grant (newest first), and the newest carry notes.
  const keepHashes = Object.keys(rec.hashes)
    .filter((hash) => hash === cur || Object.hasOwn(input.grants, hash))
    .sort((a, b) => (a === cur ? -1 : b === cur ? 1 : (input.grants[b]?.at ?? 0) - (input.grants[a]?.at ?? 0)))
    .slice(0, KEEP);
  const keepNotes = Object.keys(rec.carry).sort((a, b) => rec.carry[b]!.at - rec.carry[a]!.at).slice(0, KEEP);
  const next: CarryRecord = {
    hashes: Object.fromEntries(keepHashes.map((hash) => [hash, rec.hashes[hash]!])),
    carry: Object.fromEntries(keepNotes.map((hash) => [hash, rec.carry[hash]!])),
  };
  const value = JSON.stringify(next);
  const stored = tx.prepare("SELECT value FROM meta WHERE key = ?").get(metaKey(input.name));
  if (!stored || String(stored.value) !== value) {
    tx.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(metaKey(input.name), value);
  }
  return line;
}

/** For `botlingd plugins`: the carry note of `name` at `codeHash` (null when none or unreadable). */
export function carryNoteAt(db: Db, name: string, codeHash: string): CarryNote | null {
  try {
    const record = readRecord(db, name);
    if (!record || record === "corrupt" || !Object.hasOwn(record.carry, codeHash)) return null;
    return record.carry[codeHash]!;
  } catch {
    return null;
  }
}
