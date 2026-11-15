// M5-13b: each server writes its own `plugin:<name>` rows in its `srv:` table (D52, §8.2, §14.3, §14.4, §18.3).
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { folderHash } from "../../src/core/plugins/catalog";
import { PERMISSIONS } from "../../src/core/plugins/manifest";
import { PluginRegistry } from "../../src/core/plugins/registry";
import { MemorySecretStore } from "../../src/core/plugins/secrets";
import { EntryHash } from "../../src/protocol/ids";
import { MachineRow, PluginRow, TableRow, type PluginGrant } from "../../src/protocol/table-rows";
import { Botlingd, PLUGIN_POLL_MS } from "../../src/server/botlingd";
import { ownTableStream, putRow, readRowBody, tableRev } from "../../src/server/replica/tables";
import {
  MAX_PLUGIN_GRANTS, PluginHashCache, folderStatSignature, installedFromRegistry, manifestAsks, pluginsDigestOf,
  prunePluginGrants, reconcilePluginRows, tierOf,
} from "../../src/server/replica/plugin-rows";
import { botlingdEnv, testRoot } from "../botlingd-harness";
import { desktop, tempDir, until } from "../helpers";
import { makeCluster, profile, readServerKeys, writeStatements } from "../support/peer-cluster";
import { startServers, type TestCluster, type TestServer } from "../support/two-servers";
import { memoryStore } from "./server-slots-harness";

const createdDirs: string[] = [];
function makeTempDir(prefix: string): string {
  const dir = tempDir(prefix);
  createdDirs.push(dir);
  return dir;
}

function writePlugin(root: string, name: string, options: { version?: string; permissions?: string[]; webCode?: string } = {}): string {
  const folder = join(root, name);
  mkdirSync(join(folder, "dist"), { recursive: true });
  writeFileSync(join(folder, "package.json"), JSON.stringify({
    name,
    version: options.version ?? "1.0.0",
    engines: { ccb: "^2.0.0" },
    ccb: {
      ...(options.permissions ? { permissions: options.permissions } : {}),
      web: "dist/web.js",
    },
  }));
  writeFileSync(join(folder, "dist", "web.js"), options.webCode ?? `export function activate() { return "${name}"; }\n`);
  return folder;
}

function liveRows(server: { dataDir: string }, stream: string): Record<string, { rev: number; body: unknown }> {
  const db = new DatabaseSync(join(server.dataDir, "server.db"), { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout = 10000");
    const out: Record<string, { rev: number; body: unknown }> = {};
    for (const row of db.prepare("SELECT key, rev, body FROM rows WHERE stream = ? AND deleted = 0 ORDER BY key").all(stream) as Array<{ key: string; rev: number; body: string }>) {
      out[row.key] = { rev: Number(row.rev), body: JSON.parse(row.body) };
    }
    return out;
  } finally {
    db.close();
  }
}

afterAll(() => {
  for (const dir of createdDirs) rmSync(dir, { recursive: true, force: true });
});

describe("M5-13b: tierOf permission mapping (§14.4)", () => {
  it("maps every one of the 12 permission names and empty permissions per §14.4", () => {
    expect(Object.keys(PERMISSIONS)).toHaveLength(12);
    expect(tierOf([])).toBe("read");
    expect(tierOf(["messages"])).toBe("read");
    for (const perm of ["composer", "bots", "claude"]) {
      expect(tierOf([perm])).toBe("request");
    }
    for (const perm of ["network", "files", "exec", "sessions", "routines", "cards", "app", "studio"]) {
      expect(tierOf([perm])).toBe("write");
    }
    expect(tierOf(["messages", "composer"])).toBe("request");
    expect(tierOf(["messages", "composer", "files"])).toBe("write");
  });
});

describe("M5-13b: reconcilePluginRows and pluginsDigestOf", () => {
  it("writes one row per built-in with author builtin and a write grant at its codeHash", async () => {
    const dir = makeTempDir("plugin-rows-builtin");
    const builtIns = join(dir, "builtins");
    const library = join(dir, "plugins");
    mkdirSync(builtIns, { recursive: true });
    mkdirSync(library, { recursive: true });
    const f1 = writePlugin(builtIns, "botling.alpha", { permissions: ["messages"] });
    const f2 = writePlugin(builtIns, "botling.beta", { permissions: ["cards", "composer"] });

    const registry = new PluginRegistry(library, join(dir, "plugins.json"), new MemorySecretStore(), builtIns);
    const installed = installedFromRegistry(registry.plugins);
    const { db, writer } = memoryStore();
    const stream = ownTableStream(db);
    const now = 1_700_000_000_000;

    const res = await writer.submit((tx) => reconcilePluginRows(tx, stream, installed, now));
    expect(res.written).toBe(2);
    expect(res.tombstoned).toBe(0);
    expect(res.skipped).toEqual([]);

    const h1 = folderHash(f1);
    const h2 = folderHash(f2);
    const row1 = readRowBody(db, stream, "plugin:botling.alpha") as PluginRow;
    const row2 = readRowBody(db, stream, "plugin:botling.beta") as PluginRow;
    expect(PluginRow.parse(row1)).toEqual({
      codeHash: h1,
      manifest: manifestAsks(["messages"]),
      author: "builtin",
      grants: {
        [h1]: { tier: "write", reads: [], requests: [], grantedBy: "builtin", at: now },
      },
    });
    expect(row1.manifest.tier).toBe("read");
    expect(PluginRow.parse(row2)).toEqual({
      codeHash: h2,
      manifest: manifestAsks(["cards", "composer"]),
      author: "builtin",
      grants: {
        [h2]: { tier: "write", reads: [], requests: [], grantedBy: "builtin", at: now },
      },
    });
    expect(row2.manifest.tier).toBe("write");
    expect("files" in row1).toBe(false);

    // Idempotent when nothing changes (no rev bump, existing grant `at` preserved).
    const revBefore = tableRev(db, stream);
    const second = await writer.submit((tx) => reconcilePluginRows(tx, stream, installed, now + 5_000));
    expect(second.written).toBe(0);
    expect(second.tombstoned).toBe(0);
    expect(tableRev(db, stream)).toBe(revBefore);
    await writer.close();
    db.close();
  });

  it("adds user plugins with no grants, skips names > 64 chars with a log, and tombstones removed plugins", async () => {
    const dir = makeTempDir("plugin-rows-user");
    const library = join(dir, "plugins");
    mkdirSync(library, { recursive: true });
    const userFolder = writePlugin(library, "user.helper", { permissions: ["bots"] });
    const longName = "p".repeat(65);
    writePlugin(library, longName, { permissions: [] });

    const registry = new PluginRegistry(library, join(dir, "plugins.json"), new MemorySecretStore(), null);
    const { db, writer } = memoryStore();
    const stream = ownTableStream(db);
    const logs: string[] = [];

    const res = await writer.submit((tx) =>
      reconcilePluginRows(tx, stream, installedFromRegistry(registry.plugins), 10_000, { log: (line) => logs.push(line) }),
    );
    expect(res.written).toBe(1);
    expect(res.skipped).toEqual([longName]);
    expect(logs).toContain("plugin row skipped: name too long (65 chars)");

    const row = readRowBody(db, stream, "plugin:user.helper") as PluginRow;
    expect(row).toEqual({
      codeHash: folderHash(userFolder),
      manifest: manifestAsks(["bots"]),
      author: "user",
      grants: {},
    });
    expect(readRowBody(db, stream, `plugin:${longName}`)).toBeNull();

    // Remove the user plugin -> tombstoned.
    rmSync(userFolder, { recursive: true, force: true });
    registry.rescan();
    const removed = await writer.submit((tx) => reconcilePluginRows(tx, stream, installedFromRegistry(registry.plugins), 20_000));
    expect(removed.tombstoned).toBe(1);
    expect(readRowBody(db, stream, "plugin:user.helper")).toBeNull();
    const raw = db.prepare("SELECT deleted FROM rows WHERE stream = ? AND key = ?").get(stream, "plugin:user.helper") as { deleted: number };
    expect(raw.deleted).toBe(1);
    await writer.close();
    db.close();
  });

  it("updates codeHash when files change and keeps old grants in grants (C12); edited built-in copy loses builtin grant", async () => {
    const dir = makeTempDir("plugin-rows-grants");
    const builtIns = join(dir, "builtins");
    const library = join(dir, "plugins");
    mkdirSync(builtIns, { recursive: true });
    mkdirSync(library, { recursive: true });
    const userFolder = writePlugin(library, "user.tool", { permissions: ["composer"], webCode: "export const v = 1;\n" });
    const builtInFolder = writePlugin(builtIns, "botling.sample", { permissions: ["files"], webCode: "export const b = 1;\n" });

    const registry = new PluginRegistry(library, join(dir, "plugins.json"), new MemorySecretStore(), builtIns);
    const { db, writer } = memoryStore();
    const stream = ownTableStream(db);

    await writer.submit((tx) => reconcilePluginRows(tx, stream, installedFromRegistry(registry.plugins), 1_000));
    const oldUserHash = folderHash(userFolder);
    const oldBuiltinHash = folderHash(builtInFolder);

    // Simulate a user grant recorded on the user plugin's initial hash.
    const existingUser = readRowBody(db, stream, "plugin:user.tool") as PluginRow;
    const userGrant = { tier: "request" as const, reads: [], requests: ["chat.send" as const], grantedBy: "user" as const, at: 2_000 };
    await writer.submit((tx) => putRow(tx, stream, "plugin:user.tool", { ...existingUser, grants: { [oldUserHash]: userGrant } }));

    // Edit user plugin's web file -> new codeHash, old grant still preserved; the new hash asks for nothing more, so the
    // grant is carried to it (plugin-grant-carry.ts).
    writeFileSync(join(userFolder, "dist", "web.js"), "export const v = 2;\n");
    // Override built-in in library with same version and edited content -> author becomes "user", no builtin grant on new hash, old builtin grant preserved.
    writePlugin(library, "botling.sample", { version: "1.0.0", permissions: ["files"], webCode: "export const b = 2;\n" });
    registry.rescan();

    await writer.submit((tx) => reconcilePluginRows(tx, stream, installedFromRegistry(registry.plugins), 3_000));
    const updatedUser = readRowBody(db, stream, "plugin:user.tool") as PluginRow;
    const newUserHash = folderHash(userFolder);
    expect(newUserHash).not.toBe(oldUserHash);
    expect(updatedUser.codeHash).toBe(newUserHash);
    expect(updatedUser.grants).toEqual({ [oldUserHash]: userGrant, [newUserHash]: { ...userGrant, at: 3_000 } });

    const updatedBuiltin = readRowBody(db, stream, "plugin:botling.sample") as PluginRow;
    const newBuiltinHash = folderHash(join(library, "botling.sample"));
    expect(newBuiltinHash).not.toBe(oldBuiltinHash);
    expect(updatedBuiltin.author).toBe("user");
    expect(updatedBuiltin.codeHash).toBe(newBuiltinHash);
    expect(updatedBuiltin.grants[oldBuiltinHash]).toEqual({ tier: "write", reads: [], requests: [], grantedBy: "builtin", at: 1_000 });
    expect(updatedBuiltin.grants[newBuiltinHash]).toBeUndefined();
    await writer.close();
    db.close();
  });

  it("computes pluginsDigest deterministically from sorted <name>\\t<codeHash> lines and changes exactly on name/hash changes", () => {
    const a = { name: "alpha", codeHash: "1".repeat(64) };
    const b = { name: "beta", codeHash: "2".repeat(64) };
    const d1 = pluginsDigestOf([a, b]);
    const d2 = pluginsDigestOf([b, a]);
    expect(EntryHash.safeParse(d1).success).toBe(true);
    expect(d1).toBe(d2);
    expect(d1).toBe(createHash("sha256").update(`alpha\t${a.codeHash}\nbeta\t${b.codeHash}\n`).digest("hex"));

    expect(pluginsDigestOf([a, { name: "beta", codeHash: "3".repeat(64) }])).not.toBe(d1);
    expect(pluginsDigestOf([a, { name: "gamma", codeHash: b.codeHash }])).not.toBe(d1);
    expect(pluginsDigestOf([a])).not.toBe(d1);
  });
});

describe("M5-13b fix (b): reconcilePluginRows prunes oldest non-current-hash grants above 20", () => {
  const hashOf = (n: number) => n.toString(16).padStart(64, "0");

  it("prunes the oldest non-current grant when a built-in update adds a 21st grant so schema validation passes", async () => {
    expect(MAX_PLUGIN_GRANTS).toBe(20);
    const { db, writer } = memoryStore();
    const stream = ownTableStream(db);
    const oldGrants: Record<string, PluginGrant> = {};
    for (let i = 0; i < 20; i++) {
      oldGrants[hashOf(i + 1)] = { tier: "write", reads: [], requests: [], grantedBy: "builtin", at: 1_000 + i * 100 };
    }
    const oldestHash = hashOf(1);
    const newestOldHash = hashOf(20);
    const currentHash = hashOf(99);

    await writer.submit((tx) =>
      putRow(tx, stream, "plugin:botling.many", {
        codeHash: newestOldHash,
        manifest: manifestAsks(["files"]),
        author: "builtin",
        grants: oldGrants,
      }),
    );

    const res = await writer.submit((tx) =>
      reconcilePluginRows(tx, stream, [{
        name: "botling.many",
        codeHash: currentHash,
        manifest: manifestAsks(["files"]),
        author: "builtin",
      }], 9_000),
    );
    expect(res.written).toBe(1);

    const row = PluginRow.parse(readRowBody(db, stream, "plugin:botling.many"));
    expect(Object.keys(row.grants)).toHaveLength(20);
    expect(row.grants[oldestHash]).toBeUndefined();
    expect(row.grants[newestOldHash]).toBeDefined();
    expect(row.grants[currentHash]).toEqual({ tier: "write", reads: [], requests: [], grantedBy: "builtin", at: 9_000 });
    await writer.close();
    db.close();
  });

  it("never prunes the current codeHash even when its grant is the oldest among >20 grants", async () => {
    const currentHash = hashOf(100);
    const grants: Record<string, PluginGrant> = {
      [currentHash]: { tier: "request", reads: [], requests: ["chat.send"], grantedBy: "user", at: 10 },
    };
    for (let i = 1; i <= 21; i++) {
      grants[hashOf(i)] = { tier: "request", reads: [], requests: ["chat.send"], grantedBy: "user", at: 100 * i };
    }
    const direct = prunePluginGrants(grants, currentHash);
    expect(Object.keys(direct)).toHaveLength(20);
    expect(direct[currentHash]).toBeDefined();
    expect(direct[hashOf(1)]).toBeUndefined();
    expect(direct[hashOf(2)]).toBeUndefined();
    expect(direct[hashOf(3)]).toBeDefined();

    // Also verify reconcilePluginRows stores a valid <=20-grant row if >20 grants already exist in the table.
    const { db, writer } = memoryStore();
    const stream = ownTableStream(db);
    await writer.submit((tx) => {
      tx.prepare("INSERT INTO rows (stream, key, rev, body, deleted) VALUES (?, ?, 1, ?, 0)").run(
        stream,
        "plugin:user.many",
        JSON.stringify({ codeHash: currentHash, manifest: manifestAsks(["composer"]), author: "user", grants }),
      );
    });

    await writer.submit((tx) =>
      reconcilePluginRows(tx, stream, [{
        name: "user.many",
        codeHash: currentHash,
        manifest: manifestAsks(["composer"]),
        author: "user",
      }], 5_000),
    );

    const row = PluginRow.parse(readRowBody(db, stream, "plugin:user.many"));
    expect(Object.keys(row.grants)).toHaveLength(20);
    expect(row.grants[currentHash]).toBeDefined();
    expect(row.grants[hashOf(1)]).toBeUndefined();
    expect(row.grants[hashOf(2)]).toBeUndefined();
    expect(row.grants[hashOf(21)]).toBeDefined();
    await writer.close();
    db.close();
  });
});

describe("M5-13b fix (a): stat signature cache avoids repeated folderHash and 60 s poll keeps immediate plugins.updated sync", () => {
  it("checks mtime/size stat signature first and only recomputes folderHash for plugins that changed", () => {
    const dir = makeTempDir("plugin-hash-cache");
    const library = join(dir, "plugins");
    mkdirSync(library, { recursive: true });
    const fAlpha = writePlugin(library, "alpha.cached", { webCode: "export const a = 1;\n" });
    writePlugin(library, "beta.cached", { webCode: "export const b = 1;\n" });

    const registry = new PluginRegistry(library, join(dir, "plugins.json"), new MemorySecretStore(), null);
    const sig1 = folderStatSignature(fAlpha);
    expect(sig1).toBeTypeOf("string");

    const hashSpy = vi.fn((folder: string) => folderHash(folder));
    const cache = new PluginHashCache({ hashFolder: hashSpy });

    const first = cache.read(registry.plugins);
    expect(first).toHaveLength(2);
    expect(hashSpy).toHaveBeenCalledTimes(2);

    // Unchanged on disk: statSignature matches -> 0 folderHash calls.
    const statBefore = cache.statSignature(registry.plugins);
    const second = cache.read(registry.plugins);
    expect(hashSpy).toHaveBeenCalledTimes(2);
    expect(second).toEqual(first);
    expect(cache.statSignature(registry.plugins)).toBe(statBefore);

    // Edit only alpha.cached -> statSignature changes and only alpha.cached is re-hashed.
    writeFileSync(join(fAlpha, "dist", "web.js"), "export const a = 2000;\n");
    registry.rescan();
    expect(cache.statSignature(registry.plugins)).not.toBe(statBefore);
    const third = cache.read(registry.plugins);
    expect(hashSpy).toHaveBeenCalledTimes(3);
    expect(hashSpy).toHaveBeenLastCalledWith(fAlpha);
    expect(third.find((p) => p.name === "alpha.cached")?.codeHash).toBe(folderHash(fAlpha));
    expect(third.find((p) => p.name === "beta.cached")?.codeHash).toBe(first.find((p) => p.name === "beta.cached")?.codeHash);
  });

  it("uses a 60 s fallback poll interval in botlingd while syncing immediately on plugins.updated", async () => {
    expect(PLUGIN_POLL_MS).toBe(60_000);
    const dir = testRoot("poll");
    createdDirs.push(dir);
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    let daemon: Botlingd | null = null;
    try {
      daemon = await Botlingd.start({
        env: botlingdEnv(dir, { BOTLING_SERVER_PORT: "off", BOTLING_SERVER_BACKUP_CHECK_MS: "0" }),
        outDir: join(desktop, "out"),
      });
      const delays = setIntervalSpy.mock.calls.map(([, delay]) => delay);
      expect(delays).toContain(60_000);

      const stream = `srv:${daemon.serverId}`;
      const beforeRows = liveRows({ dataDir: dir }, stream);
      const beforeDigest = MachineRow.parse(beforeRows.machine?.body).pluginsDigest;

      // Drop a plugin and trigger core.plugins.scan() -> emits plugins.updated -> syncs immediately (< 5 s, well under 60 s).
      const addedFolder = writePlugin(join(dir, "plugins"), "immediate.sync.plugin", { permissions: ["composer"] });
      daemon.core.plugins.scan();

      const updatedRows = await until(() => {
        const rows = liveRows({ dataDir: dir }, stream);
        return "plugin:immediate.sync.plugin" in rows ? rows : null;
      }, { timeout: 5_000, every: 50, what: "immediate plugins.updated sync" });

      const row = PluginRow.parse(updatedRows["plugin:immediate.sync.plugin"]!.body);
      expect(row.codeHash).toBe(folderHash(addedFolder));
      expect(row.author).toBe("user");
      expect(row.grants).toEqual({});
      expect(MachineRow.parse(updatedRows.machine?.body).pluginsDigest).not.toBe(beforeDigest);
    } finally {
      setIntervalSpy.mockRestore();
      await daemon?.stop();
    }
  }, 60_000);
});

describe("M5-13b: two-server replication of plugin:<name> rows and machine.pluginsDigest", () => {
  let cluster: TestCluster;
  let a: TestServer;
  let b: TestServer;
  let streamB = "";

  beforeAll(async () => {
    const timersEnv = { BOTLING_SERVER_PEER_TIMERS: "ping=300,dead=1500,redial=150,redialMax=1000,revoked=2500" };
    cluster = await startServers({ name: "plugin-rows", env: { A: timersEnv, B: timersEnv } });
    ({ a, b } = cluster);
    await Promise.all([a.stop(), b.stop()]);
    const [ka, kb] = await Promise.all([readServerKeys(a.dataDir), readServerKeys(b.dataDir)]);
    const made = await makeCluster([ka, kb]);
    writeStatements(a.dataDir, made.clusterId, [...made.statements, await profile(made.clusterId, kb, kb, b.port)]);
    writeStatements(b.dataDir, made.clusterId, [...made.statements, await profile(made.clusterId, ka, ka, a.port)]);
    await Promise.all([a.start(), b.start()]);
    streamB = `srv:${kb.memberId}`;
  }, 120_000);

  afterAll(async () => { await cluster?.cleanup(); }, 60_000);

  it("publishes built-in plugin:<name> rows and machine.pluginsDigest on B and replicates them to A", async () => {
    const builtInDir = join(desktop, "out", "builtin-plugins");
    const expectedBuiltIns = readdirSync(builtInDir).filter((name) => !name.startsWith(".")).sort();
    expect(expectedBuiltIns.length).toBeGreaterThanOrEqual(1);

    const copyB = await until(() => {
      const own = liveRows(b, streamB);
      const copy = liveRows(a, streamB);
      const hasAll = expectedBuiltIns.every((name) => `plugin:${name}` in copy);
      if (!hasAll) return null;
      return JSON.stringify(copy) === JSON.stringify(own) ? copy : null;
    }, { timeout: 30_000, every: 50, what: "A's copy of B's plugin:<name> rows" });

    for (const name of expectedBuiltIns) {
      const key = `plugin:${name}`;
      const row = copyB[key]?.body as PluginRow;
      expect(TableRow.safeParse({ key, rev: copyB[key]!.rev, body: row }).success).toBe(true);
      const expectedHash = folderHash(join(builtInDir, name));
      expect(row.author).toBe("builtin");
      expect(row.codeHash).toBe(expectedHash);
      expect(row.grants[expectedHash]).toMatchObject({ tier: "write", reads: [], requests: [], grantedBy: "builtin" });
    }

    const allPluginEntries = Object.entries(copyB)
      .filter(([key]) => key.startsWith("plugin:"))
      .map(([key, entry]) => ({ name: key.slice("plugin:".length), codeHash: (entry.body as PluginRow).codeHash }));
    const expectedDigest = pluginsDigestOf(allPluginEntries);
    const machine = MachineRow.parse(copyB.machine?.body);
    expect(machine.pluginsDigest).toBe(expectedDigest);

    // Installing a user plugin on B updates B's srv: table and replicates to A.
    const dynamicName = "live.test.plugin";
    writePlugin(join(b.dataDir, "plugins"), dynamicName, { permissions: ["composer"] });
    const copyWithUser = await until(() => {
      const copy = liveRows(a, streamB);
      return `plugin:${dynamicName}` in copy ? copy : null;
    }, { timeout: 20_000, every: 100, what: "live user plugin replicated to A" });

    const userRow = PluginRow.parse(copyWithUser[`plugin:${dynamicName}`]!.body);
    expect(userRow.author).toBe("user");
    expect(userRow.manifest.tier).toBe("request");
    expect(userRow.grants).toEqual({});
    const machineWithUser = MachineRow.parse(copyWithUser.machine?.body);
    expect(machineWithUser.pluginsDigest).not.toBe(expectedDigest);

    for (const server of [a, b]) server.assertLoopbackOnly({ expectListener: true });
  }, 90_000);
});
