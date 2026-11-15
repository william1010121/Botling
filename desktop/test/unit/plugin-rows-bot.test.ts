// M5-13c: a bot writing a plugin commits `plugin:<name>` (author "bot", no grant for the new hash) and an audit row in one transaction.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { MAINTAINER_ID } from "../../src/core/maintainer";
import { folderHash } from "../../src/core/plugins/catalog";
import type { Message, MessageOf, Slot } from "../../src/protocol";
import { AuditRow, PluginRow } from "../../src/protocol/table-rows";
import { Botlingd } from "../../src/server/botlingd";
import { manifestAsks, reconcilePluginRows } from "../../src/server/replica/plugin-rows";
import { ownTableStream, putRow, readRowBody } from "../../src/server/replica/tables";
import { botlingdEnv, ScriptClient, testRoot } from "../botlingd-harness";
import { desktop, until } from "../helpers";
import { memoryStore } from "./server-slots-harness";

const isResult = (slot: Slot) => (m: Message): m is MessageOf<"cmd.result"> =>
  m.t === "cmd.result" && m.slot.target === slot.target && m.slot.n === slot.n && m.slot.originEpoch === slot.originEpoch;

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

function readSrvRows(dataDir: string, stream: string): Array<{ key: string; rev: number; body: unknown }> {
  const db = new DatabaseSync(join(dataDir, "server.db"), { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout = 10000");
    return (db.prepare("SELECT key, rev, body FROM rows WHERE stream = ? AND deleted = 0 ORDER BY rev").all(stream) as Array<{ key: string; rev: number; body: string }>)
      .map((row) => ({ key: row.key, rev: Number(row.rev), body: JSON.parse(row.body) }));
  } finally {
    db.close();
  }
}

describe("M5-13c: reconcilePluginRows bot writes and single-transaction audit", () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanups.length) {
      const fn = cleanups.pop()!;
      await fn();
    }
  });

  function withEnv(overrides: Record<string, string>): void {
    const saved: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(overrides)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    cleanups.push(() => {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });
  }

  function makeDataDir(): string {
    const root = testRoot("plugin-rows-bot");
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const dataDir = join(root, "data");
    mkdirSync(dataDir, { recursive: true });
    return dataDir;
  }

  async function startBotlingd(dataDir: string): Promise<{ daemon: Botlingd; client: ScriptClient; inc: string; originEpoch: string }> {
    const daemon = await Botlingd.start({
      env: botlingdEnv(dataDir, {
        BOTLING_SERVER_PORT: "off",
        BOTLING_SERVER_BACKUP_CHECK_MS: "0",
      }),
      outDir: join(desktop, "out"),
    });
    cleanups.push(() => daemon.stop());

    const client = new ScriptClient("script");
    cleanups.push(() => client.close());
    await client.connect(daemon.paths.socket, daemon.token);
    await client.sub(client.srv);
    const srvSnap = await client.wait((m): m is MessageOf<"snap"> => m.t === "snap" && m.stream === client.srv, "srv snap");
    return { daemon, client, inc: srvSnap.logId, originEpoch: client.originEpoch };
  }

  it("writes plugin:<name> with author bot, no grant for new hash, and audit:plugin-write in one transaction", async () => {
    const { db, writer } = memoryStore();
    cleanups.push(async () => { await writer.close(); db.close(); });
    const stream = ownTableStream(db);
    const oldHash = "1".repeat(64);
    const newHash = "2".repeat(64);
    const oldGrant = { tier: "request" as const, reads: [], requests: ["chat.send" as const], grantedBy: "user" as const, at: 1_000 };

    await writer.submit((tx) =>
      putRow(tx, stream, "plugin:bot.plugin", {
        codeHash: oldHash,
        manifest: manifestAsks(["composer"]),
        author: "user",
        grants: { [oldHash]: oldGrant },
      }),
    );

    const writeAt = 5_000;
    await writer.submit((tx) =>
      reconcilePluginRows(tx, stream, [{
        name: "bot.plugin",
        codeHash: newHash,
        manifest: manifestAsks(["files"]),
        author: "bot",
        writtenBy: { botId: MAINTAINER_ID, at: writeAt },
      }], writeAt),
    );

    const pluginRow = PluginRow.parse(readRowBody(db, stream, "plugin:bot.plugin"));
    expect(pluginRow.author).toBe("bot");
    expect(pluginRow.codeHash).toBe(newHash);
    expect(pluginRow.grants[newHash]).toBeUndefined();
    expect(pluginRow.grants[oldHash]).toEqual(oldGrant);

    const rows = db.prepare("SELECT key, rev, body FROM rows WHERE stream = ? AND deleted = 0 ORDER BY rev").all(stream) as Array<{ key: string; rev: number; body: string }>;
    const pluginDbRow = rows.find((r) => r.key === "plugin:bot.plugin")!;
    const auditRows = rows.filter((r) => r.key.startsWith("audit:"));
    expect(auditRows).toHaveLength(1);
    expect(AuditRow.parse(JSON.parse(auditRows[0]!.body))).toEqual({
      act: "plugin.write",
      at: writeAt,
      member: MAINTAINER_ID,
      name: "bot.plugin",
      hash: newHash,
    });
    expect(Number(auditRows[0]!.rev)).toBe(Number(pluginDbRow.rev) + 1);

    // Subsequent poll without writtenBy keeps author "bot" for unchanged codeHash and writes no duplicate audit row.
    const nextRes = await writer.submit((tx) =>
      reconcilePluginRows(tx, stream, [{
        name: "bot.plugin",
        codeHash: newHash,
        manifest: manifestAsks(["files"]),
        author: "user",
      }], 10_000),
    );
    expect(nextRes.written).toBe(0);
    expect((readRowBody(db, stream, "plugin:bot.plugin") as PluginRow).author).toBe("bot");
    expect(db.prepare("SELECT key FROM rows WHERE stream = ? AND key LIKE 'audit:%' AND deleted = 0").all(stream)).toHaveLength(1);

    // Rollback atomicity: throwing inside the same transaction reverts both the plugin row and the audit row.
    const thirdHash = "3".repeat(64);
    await expect(
      writer.submit((tx) => {
        reconcilePluginRows(tx, stream, [{
          name: "bot.plugin",
          codeHash: thirdHash,
          manifest: manifestAsks(["files"]),
          author: "bot",
          writtenBy: { botId: MAINTAINER_ID, at: 20_000 },
        }], 20_000);
        throw new Error("abort tx");
      }),
    ).rejects.toThrow("abort tx");

    expect((readRowBody(db, stream, "plugin:bot.plugin") as PluginRow).codeHash).toBe(newHash);
    expect(db.prepare("SELECT key FROM rows WHERE stream = ? AND key LIKE 'audit:%' AND deleted = 0").all(stream)).toHaveLength(1);
  });

  it("commits row (author bot, no grant) and plugin.write audit row in one transaction when Maintainer writes a plugin", async () => {
    const dataDir = makeDataDir();
    withEnv({ FAKE_CLAUDE_LINGER_MS: "450" });
    const { daemon, client, inc, originEpoch } = await startBotlingd(dataDir);
    const srvStream = `srv:${daemon.serverId}`;
    const maintainerStream = `bot:${MAINTAINER_ID}`;
    await client.sub(maintainerStream);

    const slot: Slot = { origin: "script", originEpoch, target: maintainerStream, n: 1 };
    client.cmd(slot, { type: "chat.send", botId: MAINTAINER_ID, text: "/linger write plugin" }, inc);
    expect((await client.wait(isResult(slot), "maintainer chat.send result")).outcome.kind).toBe("applied");

    // Wait until Maintainer's turn is actively running, then write the plugin into <dataDir>/plugins during the turn.
    await until(() => (daemon.core.snapshot(MAINTAINER_ID).bots.find((b) => b.id === MAINTAINER_ID)?.working ? true : null), { timeout: 15_000, every: 20, what: "maintainer working" });
    const botPluginName = "maintainer.crafted";
    const botPluginFolder = writePlugin(join(dataDir, "plugins"), botPluginName, { permissions: ["files", "exec"] });
    const expectedHash = folderHash(botPluginFolder);

    // Wait for Maintainer's turn to settle and publish plugin:<name> + audit row.
    const rows = await until(() => {
      const current = readSrvRows(dataDir, srvStream);
      const pRow = current.find((r) => r.key === `plugin:${botPluginName}`);
      const aRows = current.filter((r) => r.key.startsWith("audit:") && (r.body as { name?: string }).name === botPluginName);
      return pRow && aRows.length === 1 ? current : null;
    }, { timeout: 30_000, every: 50, what: "maintainer plugin row and audit row" });

    const pluginEntry = rows.find((r) => r.key === `plugin:${botPluginName}`)!;
    const pluginRow = PluginRow.parse(pluginEntry.body);
    expect(pluginRow.author).toBe("bot");
    expect(pluginRow.codeHash).toBe(expectedHash);
    expect(pluginRow.grants).toEqual({});
    expect(pluginRow.grants[expectedHash]).toBeUndefined();

    const auditEntries = rows.filter((r) => r.key.startsWith("audit:") && (r.body as { name?: string }).name === botPluginName);
    expect(auditEntries).toHaveLength(1);
    const auditBody = AuditRow.parse(auditEntries[0]!.body);
    expect(auditBody).toEqual({
      act: "plugin.write",
      at: expect.any(Number),
      member: MAINTAINER_ID,
      name: botPluginName,
      hash: expectedHash,
    });
    expect(auditEntries[0]!.rev).toBe(pluginEntry.rev + 1);

    // Verify a manual drop when Maintainer is idle still records author "user" and no plugin.write audit row.
    await until(() => (!daemon.core.snapshot(MAINTAINER_ID).bots.find((b) => b.id === MAINTAINER_ID)?.working ? true : null), { timeout: 15_000, every: 20, what: "maintainer idle" });
    writePlugin(join(dataDir, "plugins"), "user.manual.plugin", { permissions: ["composer"] });
    const withUserRows = await until(() => {
      const current = readSrvRows(dataDir, srvStream);
      return current.find((r) => r.key === "plugin:user.manual.plugin") ? current : null;
    }, { timeout: 10_000, every: 50, what: "manual user plugin row" });
    expect(PluginRow.parse(withUserRows.find((r) => r.key === "plugin:user.manual.plugin")!.body).author).toBe("user");
    expect(withUserRows.filter((r) => r.key.startsWith("audit:") && (r.body as { name?: string }).name === "user.manual.plugin")).toHaveLength(0);
  }, 60_000);

  it("marks an overridden built-in plugin as author bot with no grant at the new hash while preserving prior grants", async () => {
    const dataDir = makeDataDir();
    withEnv({ FAKE_CLAUDE_LINGER_MS: "450" });
    const { daemon, client, inc, originEpoch } = await startBotlingd(dataDir);
    const srvStream = `srv:${daemon.serverId}`;
    const maintainerStream = `bot:${MAINTAINER_ID}`;
    await client.sub(maintainerStream);

    const builtInName = "ccb-latex";
    const builtInVersion = String((JSON.parse(readFileSync(join(desktop, "builtin-plugins", builtInName, "package.json"), "utf8")) as { version: string }).version);
    const initialRows = readSrvRows(dataDir, srvStream);
    const initialBuiltIn = PluginRow.parse(initialRows.find((r) => r.key === `plugin:${builtInName}`)!.body);
    expect(initialBuiltIn.author).toBe("builtin");
    const oldHash = initialBuiltIn.codeHash;
    expect(initialBuiltIn.grants[oldHash]?.grantedBy).toBe("builtin");

    const slot: Slot = { origin: "script", originEpoch, target: maintainerStream, n: 1 };
    client.cmd(slot, { type: "chat.send", botId: MAINTAINER_ID, text: "/linger override built-in" }, inc);
    await until(() => (daemon.core.snapshot(MAINTAINER_ID).bots.find((b) => b.id === MAINTAINER_ID)?.working ? true : null), { timeout: 15_000, every: 20, what: "maintainer working on override" });

    const overrideFolder = writePlugin(join(dataDir, "plugins"), builtInName, {
      version: builtInVersion,
      permissions: ["composer", "messages"],
      webCode: "export function activate() { return 'bot-edited-latex'; }\n",
    });
    const newHash = folderHash(overrideFolder);
    expect(newHash).not.toBe(oldHash);

    const rows = await until(() => {
      const current = readSrvRows(dataDir, srvStream);
      const pRow = current.find((r) => r.key === `plugin:${builtInName}`);
      if (!pRow) return null;
      const body = pRow.body as PluginRow;
      return body.codeHash === newHash ? current : null;
    }, { timeout: 30_000, every: 50, what: "overridden built-in plugin row" });

    const pluginEntry = rows.find((r) => r.key === `plugin:${builtInName}`)!;
    const updatedRow = PluginRow.parse(pluginEntry.body);
    expect(updatedRow.author).toBe("bot");
    expect(updatedRow.codeHash).toBe(newHash);
    expect(updatedRow.grants[newHash]).toBeUndefined();
    expect(updatedRow.grants[oldHash]).toEqual(initialBuiltIn.grants[oldHash]);

    const audits = rows.filter((r) => r.key.startsWith("audit:") && (r.body as { name?: string }).name === builtInName);
    expect(audits).toHaveLength(1);
    expect(AuditRow.parse(audits[0]!.body)).toEqual({
      act: "plugin.write",
      at: expect.any(Number),
      member: MAINTAINER_ID,
      name: builtInName,
      hash: newHash,
    });
    expect(audits[0]!.rev).toBe(pluginEntry.rev + 1);
  }, 60_000);

  it.todo("does not start the plugin's server part (assert the host was not asked to load it) — waiting on M5-18a; until M5-18a is merged, tests 1 & 2 assert only the row");
});
