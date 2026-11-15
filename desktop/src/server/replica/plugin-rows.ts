// M5-13b / M5-13c / M6-03b: each server's own `plugin:<name>` rows in its `srv:` table (D52, D56, §8.2, §14.3, §14.4, §18.3, C12, C14).
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { folderHash } from "../../core/plugins/catalog";
import type { InstalledPlugin } from "../../core/plugins/registry";
import { RowKey, type AuditRow, type PluginGrant, type PluginRow, type Tier } from "../../protocol/table-rows";
import type { Db } from "../store";
import { deleteRow, putRow, readRowBody } from "./tables";

const WRITE_PERMISSIONS = new Set(["network", "files", "exec", "sessions", "routines", "cards", "app", "studio"]);
const REQUEST_PERMISSIONS = new Set(["composer", "bots", "claude"]);

/** A command a plugin may request: every command except the server-scope ones (the row schema's type). */
type PluginCommand = PluginRow["manifest"]["requests"][number];

const PERMISSION_REQUESTS: Readonly<Record<string, readonly PluginCommand[]>> = {
  composer: ["chat.send"],
  bots: ["bots.create", "chat.send"],
  claude: ["chat.send"],
};

export interface TierOptions {
  /** True when the plugin has a non-empty data folder of its own (`plugin-data/<name>/`). */
  hasData?: boolean;
}

/** Maximum number of per-codeHash grants allowed on one `plugin:<name>` row (`PluginRow` schema). */
export const MAX_PLUGIN_GRANTS = 20;

export interface InstalledPluginInput {
  name: string;
  codeHash: string;
  manifest: PluginRow["manifest"];
  author: PluginRow["author"];
  writtenBy?: { botId: string; at?: number };
}

export interface InstalledFromRegistryOptions {
  log?: (line: string) => void;
  /** Author assigned to non-built-in plugins (defaults to `"user"`; 2.x import passes `"import"`). */
  author?: Exclude<PluginRow["author"], "builtin">;
  /** Plugin data root (`<dataDir>/plugin-data`); non-built-ins with non-empty data ask `"write"`. */
  dataRoot?: string;
}

export interface ReconcilePluginRowsOptions {
  log?: (line: string) => void;
  onWritten?: (key: string, rev: number) => void;
}

export interface ReconcilePluginRowsResult {
  written: number;
  tombstoned: number;
  skipped: string[];
  digest: string;
}

/** Maps 2.x `ccb.permissions` (and whether the plugin keeps data of its own) to a 3.0 grant tier (§14.4). */
export function tierOf(permissions: readonly string[], options: TierOptions = {}): Tier {
  if (options.hasData) return "write";
  let tier: Tier = "read";
  for (const permission of permissions) {
    if (WRITE_PERMISSIONS.has(permission)) return "write";
    if (REQUEST_PERMISSIONS.has(permission)) tier = "request";
  }
  return tier;
}

/**
 * Maps 2.x `ccb.permissions` to the 3.0 commands those permissions could cause (§14.4, M6-03b):
 * - `composer` -> `chat.send`
 * - `bots` -> `bots.create`, `chat.send`
 * - `claude` -> `chat.send`
 */
export function requestsOf(permissions: readonly string[]): PluginCommand[] {
  const out = new Set<PluginCommand>();
  for (const permission of permissions) {
    const commands = PERMISSION_REQUESTS[permission];
    if (!commands) continue;
    for (const command of commands) out.add(command);
  }
  return [...out].sort();
}

/** True when `<dataRoot>/<name>/` exists and is a non-empty directory. */
export function hasPluginData(dataRoot: string, name: string): boolean {
  const dir = join(dataRoot, name);
  try {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return false;
    return readdirSync(dir).some((entry) => entry !== ".DS_Store");
  } catch {
    return false;
  }
}

/** Builds a `PluginRow.manifest` from 2.x permissions; `owns` and `provides` stay empty in 3.0. */
export function manifestAsks(permissions: readonly string[], options: TierOptions = {}): PluginRow["manifest"] {
  return {
    tier: tierOf(permissions, options),
    reads: [],
    requests: requestsOf(permissions),
    owns: [],
    provides: [],
    requires: [],
    uses: [],
    clients: [],
    needsShell: [],
  };
}

/** SHA-256 of sorted `<name>\t<codeHash>\n` lines for `machine.pluginsDigest`. */
export function pluginsDigestOf(installed: ReadonlyArray<{ name: string; codeHash: string }>): string {
  const lines = [...installed]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((plugin) => `${plugin.name}\t${plugin.codeHash}\n`)
    .join("");
  return createHash("sha256").update(lines).digest("hex");
}

function collectFileStats(dir: string, root: string, out: string[]): boolean {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!collectFileStats(full, root, out)) return false;
    } else {
      try {
        const stat = statSync(full, { bigint: true });
        const rel = relative(root, full).split(sep).join("/");
        out.push(`${rel}\0${stat.size}\0${stat.mtimeNs}\0${stat.ctimeNs}`);
      } catch {
        return false;
      }
    }
  }
  return true;
}

/** Fast mtime/size stat signature (`readdirSync` + `statSync`, zero file reads); null if unreadable. */
export function folderStatSignature(dir: string): string | null {
  const entries: string[] = [];
  if (!collectFileStats(dir, dir, entries)) return null;
  entries.sort();
  return entries.join("\n");
}

export interface PluginHashCacheOptions {
  hashFolder?: (folder: string) => string;
  statSignature?: (folder: string) => string | null;
}

interface CachedPluginHash {
  folder: string;
  builtIn: boolean;
  permissionsKey: string;
  statSig: string;
  input: InstalledPluginInput;
}

/** Caches `folderHash` per plugin keyed by folder, builtIn flag, permissions, and stat signature. */
export class PluginHashCache {
  private readonly hashFolder: (folder: string) => string;
  private readonly statFolder: (folder: string) => string | null;
  private cache = new Map<string, CachedPluginHash>();

  constructor(options: PluginHashCacheOptions = {}) {
    this.hashFolder = options.hashFolder ?? folderHash;
    this.statFolder = options.statSignature ?? folderStatSignature;
  }

  /** Stat-only signature across `plugins`; returns null if any plugin folder could not be stat-scanned. */
  statSignature(plugins: readonly InstalledPlugin[]): string | null {
    const parts: string[] = [];
    for (const plugin of plugins) {
      const sig = this.statFolder(plugin.folder);
      if (sig === null) return null;
      const permissionsKey = JSON.stringify(plugin.manifest.ccb?.permissions ?? []);
      parts.push(`${plugin.manifest.name}\0${plugin.builtIn ? 1 : 0}\0${permissionsKey}\0${plugin.folder}\0${sig}`);
    }
    return createHash("sha256").update(parts.join("\n")).digest("hex");
  }

  /** Reads installed plugin inputs, only recomputing `folderHash` for plugins whose stat signature or metadata changed. */
  read(plugins: readonly InstalledPlugin[], log?: (line: string) => void): InstalledPluginInput[] {
    const out: InstalledPluginInput[] = [];
    const nextCache = new Map<string, CachedPluginHash>();
    for (const plugin of plugins) {
      const permissions = plugin.manifest.ccb?.permissions ?? [];
      const permissionsKey = JSON.stringify(permissions);
      const statSig = this.statFolder(plugin.folder);
      const cached = this.cache.get(plugin.manifest.name);
      if (
        statSig !== null
        && cached
        && cached.folder === plugin.folder
        && cached.builtIn === plugin.builtIn
        && cached.permissionsKey === permissionsKey
        && cached.statSig === statSig
      ) {
        nextCache.set(plugin.manifest.name, cached);
        out.push(cached.input);
        continue;
      }
      let codeHash: string;
      try {
        codeHash = this.hashFolder(plugin.folder);
      } catch (error) {
        log?.(`plugin row skipped: failed to hash ${plugin.manifest.name} (${String((error as Error)?.message ?? error)})`);
        continue;
      }
      const input: InstalledPluginInput = {
        name: plugin.manifest.name,
        codeHash,
        manifest: manifestAsks(permissions),
        author: plugin.builtIn ? "builtin" : "user",
      };
      if (statSig !== null) {
        nextCache.set(plugin.manifest.name, {
          folder: plugin.folder,
          builtIn: plugin.builtIn,
          permissionsKey,
          statSig,
          input,
        });
      }
      out.push(input);
    }
    this.cache = nextCache;
    return out;
  }
}

/** Reads the installed plugin inputs from the core's registry using the catalog's folder hash (C14). */
export function installedFromRegistry(
  plugins: readonly InstalledPlugin[],
  logOrOptions?: ((line: string) => void) | InstalledFromRegistryOptions,
): InstalledPluginInput[] {
  const opts: InstalledFromRegistryOptions = typeof logOrOptions === "function"
    ? { log: logOrOptions }
    : (logOrOptions ?? {});
  const nonBuiltInAuthor = opts.author ?? "user";
  const out: InstalledPluginInput[] = [];
  for (const plugin of plugins) {
    let codeHash: string;
    try {
      codeHash = folderHash(plugin.folder);
    } catch (error) {
      opts.log?.(`plugin row skipped: failed to hash ${plugin.manifest.name} (${String((error as Error)?.message ?? error)})`);
      continue;
    }
    const hasData = !plugin.builtIn && opts.dataRoot ? hasPluginData(opts.dataRoot, plugin.manifest.name) : false;
    out.push({
      name: plugin.manifest.name,
      codeHash,
      manifest: manifestAsks(plugin.manifest.ccb?.permissions ?? [], { hasData }),
      author: plugin.builtIn ? "builtin" : nonBuiltInAuthor,
    });
  }
  return out;
}

function existingGrants(body: unknown): Record<string, PluginGrant> {
  if (!body || typeof body !== "object" || Array.isArray(body)) return {};
  const raw = (body as { grants?: unknown }).grants;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return { ...(raw as Record<string, PluginGrant>) };
}

/**
 * Keeps `grants` within `limit` (20) by pruning the oldest entries whose hash is not `currentCodeHash`.
 */
export function prunePluginGrants(
  grants: Record<string, PluginGrant>,
  currentCodeHash: string,
  limit = MAX_PLUGIN_GRANTS,
): Record<string, PluginGrant> {
  const out: Record<string, PluginGrant> = { ...grants };
  const keys = Object.keys(out);
  if (keys.length <= limit) return out;
  const removable = keys
    .filter((hash) => hash !== currentCodeHash)
    .sort((a, b) => (out[a]!.at - out[b]!.at) || (a < b ? -1 : a > b ? 1 : 0));
  let count = keys.length;
  for (const hash of removable) {
    if (count <= limit) break;
    delete out[hash];
    count -= 1;
  }
  return out;
}

/**
 * Writes changed `plugin:<name>` rows (plus an `audit:plugin-write` row when `writtenBy` is set) and tombstones removed ones in `stream`.
 * Never drops an existing grant on a hash change (C12) beyond the 20-grant limit; built-ins keep a `write` grant at their current hash (§14.4).
 */
export function reconcilePluginRows(
  tx: Db,
  stream: string,
  installed: readonly InstalledPluginInput[],
  now: number,
  options: ReconcilePluginRowsOptions = {},
): ReconcilePluginRowsResult {
  const activeKeys = new Set<string>();
  const digestEntries: Array<{ name: string; codeHash: string }> = [];
  const skipped: string[] = [];
  let written = 0;

  for (const plugin of installed) {
    if (plugin.name.length > 64) {
      options.log?.(`plugin row skipped: name too long (${plugin.name.length} chars)`);
      skipped.push(plugin.name);
      continue;
    }
    const key = `plugin:${plugin.name}`;
    if (!RowKey.safeParse(key).success) {
      options.log?.(`plugin row skipped: invalid name (${plugin.name})`);
      skipped.push(plugin.name);
      continue;
    }
    activeKeys.add(key);
    digestEntries.push({ name: plugin.name, codeHash: plugin.codeHash });

    const prev = readRowBody(tx, stream, key) as Partial<PluginRow> | null;
    const rawGrants = existingGrants(prev);
    const author: PluginRow["author"] = plugin.writtenBy
      ? "bot"
      : plugin.author === "user" && prev?.author === "bot" && prev?.codeHash === plugin.codeHash
        ? "bot"
        : plugin.author;
    if (author === "builtin") {
      const current = rawGrants[plugin.codeHash];
      if (!current || (current.grantedBy === "builtin" && current.tier !== "write")) {
        rawGrants[plugin.codeHash] = { tier: "write", reads: [], requests: [], grantedBy: "builtin", at: now };
      }
    }
    const grants = prunePluginGrants(rawGrants, plugin.codeHash);

    const body: PluginRow = {
      codeHash: plugin.codeHash,
      manifest: plugin.manifest,
      author,
      grants,
    };
    const rev = putRow(tx, stream, key, body);
    if (rev != null) {
      written += 1;
      options.onWritten?.(key, rev);
    }
    if (plugin.writtenBy) {
      const auditKey = `audit:plugin-write.${randomUUID()}`;
      const auditBody: AuditRow = {
        act: "plugin.write",
        at: plugin.writtenBy.at ?? now,
        member: plugin.writtenBy.botId,
        name: plugin.name,
        hash: plugin.codeHash,
      };
      const auditRev = putRow(tx, stream, auditKey, auditBody);
      if (auditRev != null) options.onWritten?.(auditKey, auditRev);
    }
  }

  let tombstoned = 0;
  for (const row of tx.prepare("SELECT key FROM rows WHERE stream = ? AND key LIKE 'plugin:%' AND deleted = 0").all(stream)) {
    const key = String(row.key);
    if (activeKeys.has(key)) continue;
    const rev = deleteRow(tx, stream, key, now);
    if (rev != null) {
      tombstoned += 1;
      options.onWritten?.(key, rev);
    }
  }

  return { written, tombstoned, skipped, digest: pluginsDigestOf(digestEntries) };
}
