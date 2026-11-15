// M5-13b: each server's own `plugin:<name>` rows in its `srv:` table (D52, D56, §8.2, §14.3, §14.4, §18.3, C12, C14).
import { createHash } from "node:crypto";
import { folderHash } from "../../core/plugins/catalog";
import type { InstalledPlugin } from "../../core/plugins/registry";
import { RowKey, type PluginGrant, type PluginRow, type Tier } from "../../protocol/table-rows";
import type { Db } from "../store";
import { deleteRow, putRow, readRowBody } from "./tables";

const WRITE_PERMISSIONS = new Set(["network", "files", "exec", "sessions", "routines", "cards", "app", "studio"]);
const REQUEST_PERMISSIONS = new Set(["composer", "bots", "claude"]);

export interface InstalledPluginInput {
  name: string;
  codeHash: string;
  manifest: PluginRow["manifest"];
  author: PluginRow["author"];
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

/** Maps 2.x `ccb.permissions` to a 3.0 grant tier (§14.4). */
export function tierOf(permissions: readonly string[]): Tier {
  let tier: Tier = "read";
  for (const permission of permissions) {
    if (WRITE_PERMISSIONS.has(permission)) return "write";
    if (REQUEST_PERMISSIONS.has(permission)) tier = "request";
  }
  return tier;
}

/** Builds a `PluginRow.manifest` from 2.x permissions; `requests`, `owns`, `provides` stay empty in 3.0. */
export function manifestAsks(permissions: readonly string[]): PluginRow["manifest"] {
  return {
    tier: tierOf(permissions),
    reads: [],
    requests: [],
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
export function installedFromRegistry(plugins: readonly InstalledPlugin[], log?: (line: string) => void): InstalledPluginInput[] {
  const out: InstalledPluginInput[] = [];
  for (const plugin of plugins) {
    let codeHash: string;
    try {
      codeHash = folderHash(plugin.folder);
    } catch (error) {
      log?.(`plugin row skipped: failed to hash ${plugin.manifest.name} (${String((error as Error)?.message ?? error)})`);
      continue;
    }
    out.push({
      name: plugin.manifest.name,
      codeHash,
      manifest: manifestAsks(plugin.manifest.ccb?.permissions ?? []),
      author: plugin.builtIn ? "builtin" : "user",
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
