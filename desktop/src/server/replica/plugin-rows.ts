// M5-13b / M6-03b: each server's own `plugin:<name>` rows in its `srv:` table (D52, D56, §8.2, §14.3, §14.4, §18.3, C12, C14).
import { createHash } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { CommandType } from "../../contract";
import { folderHash } from "../../core/plugins/catalog";
import type { InstalledPlugin } from "../../core/plugins/registry";
import { RowKey, type PluginGrant, type PluginRow, type Tier } from "../../protocol/table-rows";
import type { Db } from "../store";
import { deleteRow, putRow, readRowBody } from "./tables";

const WRITE_PERMISSIONS = new Set(["network", "files", "exec", "sessions", "routines", "cards", "app", "studio"]);
const REQUEST_PERMISSIONS = new Set(["composer", "bots", "claude"]);

const PERMISSION_REQUESTS: Readonly<Record<string, readonly CommandType[]>> = {
  composer: ["chat.send"],
  bots: ["bots.create", "chat.send"],
  claude: ["chat.send"],
};

export interface TierOptions {
  /** True when the plugin has a non-empty data folder of its own (`plugin-data/<name>/`). */
  hasData?: boolean;
}

export interface InstalledPluginInput {
  name: string;
  codeHash: string;
  manifest: PluginRow["manifest"];
  author: PluginRow["author"];
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
export function requestsOf(permissions: readonly string[]): CommandType[] {
  const out = new Set<CommandType>();
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
 * Writes changed `plugin:<name>` rows and tombstones removed ones in `stream`.
 * Never drops an existing grant on a hash change (C12); built-ins keep a `write` grant at their current hash (§14.4).
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

    const grants = existingGrants(readRowBody(tx, stream, key));
    if (plugin.author === "builtin") {
      const current = grants[plugin.codeHash];
      if (!current || (current.grantedBy === "builtin" && current.tier !== "write")) {
        grants[plugin.codeHash] = { tier: "write", reads: [], requests: [], grantedBy: "builtin", at: now };
      }
    }

    const body: PluginRow = {
      codeHash: plugin.codeHash,
      manifest: plugin.manifest,
      author: plugin.author,
      grants,
    };
    const rev = putRow(tx, stream, key, body);
    if (rev != null) {
      written += 1;
      options.onWritten?.(key, rev);
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
