// A plugin update keeps its grant unless it asks for more (plugin-grant-carry.ts). Real plugin folders in a temp dir, the
// registry and reconcile the server uses, an in-memory server.db; `botlingd plugins` is driven through PluginAdmin.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { folderHash } from "../../src/core/plugins/catalog";
import { PluginRegistry } from "../../src/core/plugins/registry";
import { MemorySecretStore } from "../../src/core/plugins/secrets";
import { PluginRow, type AuditRow, type PluginGrant } from "../../src/protocol/table-rows";
import { mayRunPluginServerPart } from "../../src/server/botlingd";
import { PluginAdmin } from "../../src/server/plugin-admin";
import { pluginsCommand } from "../../src/server/plugin-cli";
import { installedFromRegistry, reconcilePluginRows } from "../../src/server/replica/plugin-rows";
import { ownTableStream, putRow, readRowBody } from "../../src/server/replica/tables";
import type { AdminClient } from "../../src/server/pairing";
import { tempDir } from "../helpers";
import { memoryStore } from "./server-slots-harness";

const dirs: string[] = [];
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

interface Spec { version?: string; permissions?: string[]; host?: boolean; claude?: boolean; menus?: boolean; code?: string }

function writePlugin(library: string, name: string, spec: Spec): string {
  const folder = join(library, name);
  mkdirSync(join(folder, "dist"), { recursive: true });
  writeFileSync(join(folder, "package.json"), JSON.stringify({
    name, version: spec.version ?? "1.0.0", engines: { ccb: "^2.7.0" },
    ccb: {
      permissions: spec.permissions ?? [], web: "dist/web.js",
      ...(spec.host ? { host: "dist/host.mjs" } : {}),
      ...(spec.claude ? { claude: "claude" } : {}),
      contributes: {
        commands: [{ id: `${name}.start`, title: "Start" }],
        ...(spec.menus ? { menus: { "browser/tab": [{ command: `${name}.start`, when: { ext: "pdf" } }, { command: `${name}.start`, when: { host: "arxiv.org" } }] } } : {}),
      },
    },
  }));
  writeFileSync(join(folder, "dist", "web.js"), spec.code ?? "export const v = 1;\n");
  if (spec.host) writeFileSync(join(folder, "dist", "host.mjs"), "export function activate() {}\n");
  if (spec.claude) {
    mkdirSync(join(folder, "claude", ".claude-plugin"), { recursive: true });
    writeFileSync(join(folder, "claude", ".claude-plugin", "plugin.json"), JSON.stringify({ name }));
  }
  return folder;
}

async function setup(name: string, before: Spec, grant: Omit<PluginGrant, "at" | "grantedBy"> & { grantedBy?: PluginGrant["grantedBy"] }) {
  const dir = tempDir(`grant-carry-${name}`);
  dirs.push(dir);
  const library = join(dir, "plugins");
  mkdirSync(library, { recursive: true });
  const folder = writePlugin(library, name, before);
  const registry = new PluginRegistry(library, join(dir, "plugins.json"), new MemorySecretStore(), null);
  const { db, writer } = memoryStore();
  const stream = ownTableStream(db);
  const logs: string[] = [];
  const reconcile = (now: number) => writer.submit((tx) => reconcilePluginRows(tx, stream, installedFromRegistry(registry.plugins), now, { log: (line) => logs.push(line) }));
  await reconcile(1_000);
  const oldHash = folderHash(folder);
  const row = readRowBody(db, stream, `plugin:${name}`) as PluginRow;
  await writer.submit((tx) => putRow(tx, stream, `plugin:${name}`, { ...row, grants: { [oldHash]: { grantedBy: "user", ...grant, at: 2_000 } } }));
  const update = async (after: Spec) => {
    writePlugin(library, name, after);
    registry.rescan();
    await reconcile(3_000);
    return { newHash: folderHash(folder), row: PluginRow.parse(readRowBody(db, stream, `plugin:${name}`)) };
  };
  const admin = new PluginAdmin({ serverId: stream.slice(4), reader: () => db, runtime: { receive: async () => { throw new Error("not used"); } } });
  const cli = async () => {
    const out: string[] = [];
    const client = { request: async (op: { op: "plugins.list" }) => admin.handle(op) } as unknown as AdminClient;
    await pluginsCommand(client, { out: (line) => out.push(line), ask: async () => null }, []);
    return out;
  };
  const audits = () => (db.prepare("SELECT key, body FROM rows WHERE stream = ? AND key LIKE 'audit:plugin-carry.%' AND deleted = 0").all(stream) as Array<{ body: string }>).map((r) => JSON.parse(r.body) as AuditRow);
  return { db, writer, stream, oldHash, update, reconcile, admin, cli, audits, logs, registry, library, folder };
}

const WRITE = { tier: "write" as const, reads: [], requests: ["bots.create" as const, "chat.send" as const] };

describe("a plugin update keeps its grant unless it asks for more", () => {
  it("same asks (a new version, a new menu entry with when.host): the grant is carried to the new hash, audited, commands may run, CLI says so", async () => {
    const before: Spec = { version: "0.3.0", permissions: ["files", "exec", "bots", "network"], host: true, claude: true };
    const t = await setup("reading-coach", before, WRITE);
    const { newHash, row } = await t.update({ ...before, version: "0.4.0", menus: true, code: "export const v = 2;\n" });
    expect(newHash).not.toBe(t.oldHash);
    expect(row.codeHash).toBe(newHash);
    expect(row.grants[newHash]).toEqual({ ...WRITE, grantedBy: "user", at: 3_000 });
    expect(row.grants[t.oldHash]).toBeDefined();
    expect(mayRunPluginServerPart(() => t.db, t.stream, "reading-coach", newHash)).toBe(true);
    expect(t.audits()).toEqual([{ act: "plugin.carry", at: 3_000, name: "reading-coach", hash: newHash, reason: `carried from ${t.oldHash} at tier write` }]);
    expect(t.admin.list()).toEqual([{ name: "reading-coach", codeHash: newHash, tier: "write", asks: "write", carriedFrom: t.oldHash }]);
    expect(await t.cli()).toEqual([`reading-coach  Change its own data on the server  (code ${newHash.slice(0, 8)}, carried from ${t.oldHash.slice(0, 8)})`]);
    expect(t.logs).toContain(`plugin grant carried: reading-coach ${t.oldHash.slice(0, 8)} -> ${newHash.slice(0, 8)} (tier write)`);
  });

  it("fewer asks: carried, lowered to what the new code asks", async () => {
    const t = await setup("p-fewer", { permissions: ["files", "bots"] }, WRITE);
    const { newHash, row } = await t.update({ permissions: ["bots"], code: "export const v = 2;\n" });
    expect(row.manifest.tier).toBe("request");
    expect(row.grants[newHash]).toEqual({ tier: "request", reads: [], requests: ["bots.create", "chat.send"], grantedBy: "user", at: 3_000 });
  });

  it.each([
    ["a new permission in the same tier (exec)", { permissions: ["files"] }, { permissions: ["files", "exec"] }, ['permission exec']],
    ["network", { permissions: ["files"] }, { permissions: ["files", "network"] }, ['permission network']],
    ["a higher tier", { permissions: ["bots"] }, { permissions: ["bots", "files"] }, ["tier write", "permission files"]],
    ["a new program part", { permissions: ["files"] }, { permissions: ["files"], host: true }, ["part host"]],
    ["a new bot tools folder", { permissions: ["files"] }, { permissions: ["files"], claude: true }, ["part claude"]],
  ] as Array<[string, Spec, Spec, string[]]>)("asks for more (%s): not allowed, needs Allow again, CLI says what grew", async (_label, before, after, grew) => {
    const t = await setup("p-more", before, before.permissions?.includes("files") ? { tier: "write", reads: [], requests: [] } : { tier: "request", reads: [], requests: ["bots.create", "chat.send"] });
    const { newHash, row } = await t.update({ ...after, code: "export const v = 2;\n" });
    expect(Object.hasOwn(row.grants, newHash)).toBe(false);
    expect(mayRunPluginServerPart(() => t.db, t.stream, "p-more", newHash)).toBe(false);
    expect(t.audits()).toEqual([]);
    expect(t.admin.list()[0]!.grewFrom).toEqual({ codeHash: t.oldHash, grew });
    expect((await t.cli())[0]).toBe(`p-more  Not allowed  (code ${newHash.slice(0, 8)}; asks more than code ${t.oldHash.slice(0, 8)}: ${grew.join(", ")}; allow it again)`);
  });

  it("a different source (now installed from elsewhere): not carried", async () => {
    const t = await setup("p-source", { permissions: ["files"] }, { tier: "write", reads: [], requests: [] });
    (t.registry as unknown as { state: { installed?: Record<string, string> } }).state.installed = { "p-source": "https://example.invalid/other.git" };
    const { newHash, row } = await t.update({ permissions: ["files"], code: "export const v = 2;\n" });
    expect(Object.hasOwn(row.grants, newHash)).toBe(false);
    expect(t.admin.list()[0]!.grewFrom?.grew).toEqual(["another source"]);
  });

  it("each new hash is decided once: a revoke after the carry stays revoked", async () => {
    const t = await setup("p-revoke", { permissions: ["files"] }, { tier: "write", reads: [], requests: [] });
    const { newHash, row } = await t.update({ permissions: ["files"], code: "export const v = 2;\n" });
    expect(row.grants[newHash]?.tier).toBe("write");
    const { [newHash]: _gone, ...rest } = row.grants;
    await t.writer.submit((tx) => putRow(tx, t.stream, "plugin:p-revoke", { ...row, grants: rest }));
    await t.reconcile(4_000);
    const again = PluginRow.parse(readRowBody(t.db, t.stream, "plugin:p-revoke"));
    expect(Object.hasOwn(again.grants, newHash)).toBe(false);
    expect(t.admin.list()[0]).toEqual({ name: "p-revoke", codeHash: newHash, tier: "none", asks: "write" });
  });

  it("a grant from before the asks record (the reading-coach data: row already at the new hash, grant only at the old one) carries on the next start when the new asks are within the grant", async () => {
    const { db, writer } = memoryStore();
    const stream = ownTableStream(db);
    const dir = tempDir("grant-carry-legacy");
    dirs.push(dir);
    const library = join(dir, "plugins");
    mkdirSync(library, { recursive: true });
    const folder = writePlugin(library, "reading-coach", { version: "0.4.0", permissions: ["files", "exec", "bots", "network"], host: true, claude: true, menus: true });
    const newHash = folderHash(folder);
    const registry = new PluginRegistry(library, join(dir, "plugins.json"), new MemorySecretStore(), null);
    const input = installedFromRegistry(registry.plugins);
    const oldHash = "4d9bac0566d3ca220a837eba6d48c6496eb75257a36853c7775d662c52634cc8";
    await writer.submit((tx) => putRow(tx, stream, "plugin:reading-coach", {
      author: "bot", codeHash: newHash, manifest: input[0]!.manifest,
      grants: { [oldHash]: { at: 1_794_752_646_777, grantedBy: "user", reads: [], requests: ["bots.create", "chat.send"], tier: "write" } },
    }));
    await writer.submit((tx) => reconcilePluginRows(tx, stream, input, 1_800_000_000_000));
    const row = PluginRow.parse(readRowBody(db, stream, "plugin:reading-coach"));
    expect(row.grants[newHash]).toEqual({ tier: "write", reads: [], requests: ["bots.create", "chat.send"], grantedBy: "user", at: 1_800_000_000_000 });
    expect(mayRunPluginServerPart(() => db, stream, "reading-coach", newHash)).toBe(true);
  });

  it("a grant from before the asks record that is below the new asks is not carried (unknown, so refused)", async () => {
    const { db, writer } = memoryStore();
    const stream = ownTableStream(db);
    const dir = tempDir("grant-carry-legacy-low");
    dirs.push(dir);
    const library = join(dir, "plugins");
    mkdirSync(library, { recursive: true });
    const folder = writePlugin(library, "p-low", { permissions: ["files"] });
    const newHash = folderHash(folder);
    const registry = new PluginRegistry(library, join(dir, "plugins.json"), new MemorySecretStore(), null);
    const input = installedFromRegistry(registry.plugins);
    await writer.submit((tx) => putRow(tx, stream, "plugin:p-low", { author: "user", codeHash: newHash, manifest: input[0]!.manifest, grants: { OLD: { at: 5, grantedBy: "user", reads: [], requests: [], tier: "read" } } }));
    await writer.submit((tx) => reconcilePluginRows(tx, stream, input, 10));
    const row = PluginRow.parse(readRowBody(db, stream, "plugin:p-low"));
    expect(Object.hasOwn(row.grants, newHash)).toBe(false);
  });

  it("a built-in's grant is never carried to a library copy", async () => {
    const { db, writer } = memoryStore();
    const stream = ownTableStream(db);
    const dir = tempDir("grant-carry-builtin");
    dirs.push(dir);
    const library = join(dir, "plugins");
    mkdirSync(library, { recursive: true });
    const folder = writePlugin(library, "botling.x", { permissions: ["files"] });
    const registry = new PluginRegistry(library, join(dir, "plugins.json"), new MemorySecretStore(), null);
    const input = installedFromRegistry(registry.plugins);
    await writer.submit((tx) => putRow(tx, stream, "plugin:botling.x", { author: "builtin", codeHash: "BUILTIN", manifest: input[0]!.manifest, grants: { BUILTIN: { at: 5, grantedBy: "builtin", reads: [], requests: [], tier: "write" } } }));
    await writer.submit((tx) => reconcilePluginRows(tx, stream, input, 10));
    const row = PluginRow.parse(readRowBody(db, stream, "plugin:botling.x"));
    expect(Object.hasOwn(row.grants, folderHash(folder))).toBe(false);
  });
});
