// M6-04 (B-20a): imported third-party plugins start read-only with no `grantedBy: "import"`,
// the import report lists each one with "approve to restore", and botlingd preserves `author: "import"`
// and `hasData` write asks until the user approves via `plugin.grant`.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { PluginsView } from "../../src/contract";
import { folderHash } from "../../src/core/plugins/catalog";
import { PluginRegistry } from "../../src/core/plugins/registry";
import { MemorySecretStore } from "../../src/core/plugins/secrets";
import type { Message, MessageOf, Slot } from "../../src/protocol";
import { PluginRow } from "../../src/protocol/table-rows";
import { Botlingd, mayRunPluginServerPart, readPluginGrant } from "../../src/server/botlingd";
import { formatImportReport, formatPluginsReportSection, readPluginReportEntries } from "../../src/server/import/report";
import { runImport } from "../../src/server/import/run";
import {
  PluginHashCache,
  installedFromRegistry,
  manifestAsks,
  reconcilePluginRows,
} from "../../src/server/replica/plugin-rows";
import { ownTableStream, putRow, readRowBody } from "../../src/server/replica/tables";
import { pluginApproved } from "../../src/server/slots/grant-check";
import { openReaderDb } from "../../src/server/store/connection";
import { botlingdEnv, ScriptClient, testRoot } from "../botlingd-harness";
import { desktop, until } from "../helpers";
import { make2xFolder } from "../support/fixture-2x";
import { memoryStore } from "./server-slots-harness";

const HELD_BACK_NOTICE = "Its program part is off until you allow it to change its own data on this server.";

const isResult = (slot: Slot) => (m: Message): m is MessageOf<"cmd.result"> =>
  m.t === "cmd.result" && m.slot.target === slot.target && m.slot.n === slot.n && m.slot.originEpoch === slot.originEpoch;

function writePlugin(
  root: string,
  name: string,
  options: {
    version?: string;
    permissions?: string[];
    host?: string | null;
    commands?: Array<{ id: string; title: string }>;
  } = {},
): string {
  const folder = join(root, name);
  mkdirSync(join(folder, "dist"), { recursive: true });
  const ccb: Record<string, unknown> = {
    ...(options.permissions ? { permissions: options.permissions } : {}),
    web: "dist/web.js",
    ...(options.host ? { host: "dist/host.mjs" } : {}),
    ...(options.commands ? { contributes: { commands: options.commands } } : {}),
  };
  writeFileSync(
    join(folder, "package.json"),
    JSON.stringify({
      name,
      version: options.version ?? "1.0.0",
      engines: { ccb: "^2.0.0" },
      ccb,
    }),
  );
  writeFileSync(join(folder, "dist", "web.js"), `export function activate() { return "${name}"; }\n`);
  if (options.host) {
    writeFileSync(join(folder, "dist", "host.mjs"), options.host);
  }
  return folder;
}

function readAllPluginRows(dataDir: string): Array<{ key: string; row: PluginRow }> {
  const db = openReaderDb(join(dataDir, "server.db"));
  try {
    const stream = ownTableStream(db);
    const rows = db
      .prepare("SELECT key, body FROM rows WHERE stream = ? AND key LIKE 'plugin:%' AND deleted = 0 ORDER BY key")
      .all(stream) as Array<{ key: string; body: string }>;
    return rows.map((r) => ({ key: r.key, row: PluginRow.parse(JSON.parse(r.body)) }));
  } finally {
    db.close();
  }
}

function extractPluginsSection(reportText: string): string {
  const marker = "\nPlugins\n";
  const start = reportText.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  const after = reportText.slice(start + 1);
  const end = after.indexOf("\n\n");
  return end === -1 ? after : after.slice(0, end);
}

describe("M6-04 (B-20a): imported third-party plugins start read-only with approve to restore", () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanups.length) {
      const fn = cleanups.pop()!;
      await fn();
    }
  });

  function makeTempRoot(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), `botling-m6-04-${prefix}-`));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
  }

  it("never writes grantedBy: import in dry-run or live import and lists approve to restore identically", async () => {
    const root = makeTempRoot("report-parity");
    const src = join(root, "v2");
    const dryTarget = join(root, "v3-dry");
    const liveTarget = join(root, "v3-live");
    const builtIns = join(root, "builtins");
    mkdirSync(builtIns, { recursive: true });

    const fx = make2xFolder(src);
    // Built-in plugin
    writePlugin(builtIns, "note", { permissions: ["files"] });
    // Installed + enabled request-tier plugin
    writePlugin(join(src, "plugins"), "reading-coach", { permissions: ["composer", "messages"] });
    // Installed + enabled write-tier plugin
    writePlugin(join(src, "plugins"), "host-tool", { permissions: ["files"] });
    // Non-installed (e.g. Maintainer-written) plugin with non-empty plugin-data -> write ask
    writePlugin(join(src, "plugins"), "data-tool", { permissions: ["messages"] });
    mkdirSync(join(src, "plugin-data", "data-tool"), { recursive: true });
    writeFileSync(join(src, "plugin-data", "data-tool", "store.json"), JSON.stringify({ ok: true }));
    // Read-only plugin (no restore needed)
    writePlugin(join(src, "plugins"), "plain-reader", { permissions: ["messages"] });
    // Disabled plugin asking exec -> still imported read-only and listed approve to restore
    writePlugin(join(src, "plugins"), "disabled-tool", { permissions: ["exec"] });

    // Update plugins.json to mark installed & disabled
    const pluginsJsonPath = join(src, "plugins.json");
    const rawPluginsJson = JSON.parse(readFileSync(pluginsJsonPath, "utf8")) as Record<string, unknown>;
    rawPluginsJson.installed = {
      ...(rawPluginsJson.installed as Record<string, string>),
      "reading-coach": "https://example.invalid/reading-coach.git",
      "host-tool": "https://example.invalid/host-tool.git",
    };
    rawPluginsJson.disabled = ["disabled-tool"];
    writeFileSync(pluginsJsonPath, JSON.stringify(rawPluginsJson, null, 2));

    const pkgStatBefore = statSync(join(src, "plugins", "reading-coach", "package.json"));

    const dry = await runImport({ sourceDir: src, targetDir: dryTarget, dryRun: true, builtInsDir: builtIns });
    const live = await runImport({ sourceDir: src, targetDir: liveTarget, dryRun: false, builtInsDir: builtIns });

    // Dry-run and live Plugins sections match identically (same ordering, same wording).
    expect(extractPluginsSection(dry.reportText)).toBe(extractPluginsSection(live.reportText));

    const section = extractPluginsSection(live.reportText);
    expect(section).toContain("note            built in        can change its own data");
    expect(section).toContain("disabled-tool   from Botling 2  nothing allowed yet · asks to change its own data · approve in Settings › Plugins");
    expect(section).toContain("data-tool       from Botling 2  nothing allowed yet · asks to change its own data · approve in Settings › Plugins");
    expect(section).toContain("host-tool       from Botling 2  nothing allowed yet · asks to change its own data · approve in Settings › Plugins");
    expect(section).toContain("reading-coach   from Botling 2  nothing allowed yet · asks to send messages · approve in Settings › Plugins");
    // No grant at the running hash refuses every command (grant-check.ts): a plugin that asks only to read waits for approval too.
    expect(section).toContain("plain-reader    from Botling 2  nothing allowed yet · asks to read only · approve in Settings › Plugins");
    expect(live.reportText).toContain("plugins: 7 (6 wait for your approval in Settings › Plugins)");

    // Verify server.db has zero grantedBy: "import" and zero grants on every non-built-in plugin.
    const rows = readAllPluginRows(liveTarget);
    expect(rows.map((r) => r.key)).toEqual([
      "plugin:data-tool",
      "plugin:disabled-tool",
      "plugin:host-tool",
      "plugin:note",
      "plugin:plain-reader",
      "plugin:reading-coach",
      `plugin:${fx.pluginName}`,
    ]);

    for (const { key, row } of rows) {
      if (key === "plugin:note") {
        expect(row.author).toBe("builtin");
        expect(row.grants[row.codeHash]?.grantedBy).toBe("builtin");
        expect(row.grants[row.codeHash]?.tier).toBe("write");
      } else {
        expect(row.author).toBe("import");
        expect(row.grants).toEqual({});
        expect(JSON.stringify(row.grants)).not.toContain("import");
        for (const grant of Object.values(row.grants)) {
          expect(grant.grantedBy).not.toBe("import");
        }
      }
    }

    // Source folder untouched.
    const pkgStatAfter = statSync(join(src, "plugins", "reading-coach", "package.json"));
    expect(pkgStatAfter.size).toBe(pkgStatBefore.size);
    expect(pkgStatAfter.mtimeMs).toBe(pkgStatBefore.mtimeMs);
  });

  it("PluginHashCache tracks dataRoot hasData changes and reconcilePluginRows preserves author: import", async () => {
    const root = makeTempRoot("cache-and-reconcile");
    const library = join(root, "plugins");
    const dataRoot = join(root, "plugin-data");
    mkdirSync(library, { recursive: true });
    mkdirSync(dataRoot, { recursive: true });

    const pluginDir = writePlugin(library, "data-only", { permissions: ["messages"] });
    const hash = folderHash(pluginDir);

    const registry = new PluginRegistry(library, join(root, "plugins.json"), new MemorySecretStore(), null);
    const cache = new PluginHashCache({ dataRoot });

    // Initially empty plugin-data -> read tier
    const sigEmpty = cache.statSignature(registry.plugins);
    const first = cache.read(registry.plugins);
    expect(first).toHaveLength(1);
    expect(first[0]!.manifest.tier).toBe("read");

    // Non-empty plugin-data -> statSignature changes and read() elevates manifest.tier to write
    mkdirSync(join(dataRoot, "data-only"), { recursive: true });
    writeFileSync(join(dataRoot, "data-only", "state.json"), "{}");
    const sigNonEmpty = cache.statSignature(registry.plugins);
    expect(sigNonEmpty).not.toBe(sigEmpty);
    const second = cache.read(registry.plugins);
    expect(second[0]!.manifest.tier).toBe("write");

    // reconcilePluginRows: imported row keeps author: "import" across runtime user-syncs at the same codeHash
    const { db, writer } = memoryStore();
    cleanups.push(async () => {
      await writer.close();
      db.close();
    });
    const stream = ownTableStream(db);
    await writer.submit((tx) =>
      reconcilePluginRows(tx, stream, [{ ...second[0]!, author: "import" }], 1_000),
    );
    let row = PluginRow.parse(readRowBody(db, stream, "plugin:data-only"));
    expect(row.author).toBe("import");
    expect(row.grants).toEqual({});

    // Runtime sync passes author: "user" (from PluginHashCache); same codeHash must preserve author: "import"
    await writer.submit((tx) => reconcilePluginRows(tx, stream, second, 2_000));
    row = PluginRow.parse(readRowBody(db, stream, "plugin:data-only"));
    expect(row.author).toBe("import");
    expect(row.manifest.tier).toBe("write");
    expect(row.grants).toEqual({});

    // If the plugin code changes on disk (different codeHash), author becomes "user"
    writeFileSync(join(pluginDir, "dist", "web.js"), 'export function activate() { return "v2"; }\n');
    const newHash = folderHash(pluginDir);
    expect(newHash).not.toBe(hash);
    const third = cache.read(registry.plugins);
    await writer.submit((tx) => reconcilePluginRows(tx, stream, third, 3_000));
    row = PluginRow.parse(readRowBody(db, stream, "plugin:data-only"));
    expect(row.author).toBe("user");
    expect(row.grants).toEqual({});
  });

  it("handles prototype-property codeHash keys safely via Object.hasOwn", async () => {
    const { db, writer } = memoryStore();
    cleanups.push(async () => {
      await writer.close();
      db.close();
    });
    const stream = ownTableStream(db);
    const protoRow: PluginRow = {
      codeHash: "toString",
      manifest: manifestAsks(["files"]),
      author: "import",
      grants: {},
    };
    await writer.submit((tx) => putRow(tx, stream, "plugin:proto-check", protoRow));
    expect(mayRunPluginServerPart(() => db, stream, "proto-check", "toString")).toBe(false);
    expect(readPluginGrant(db, stream.slice("srv:".length), "proto-check")).toBe("none");
    const entries = readPluginReportEntries(db, stream);
    expect(formatPluginsReportSection(entries)).toContain(
      "proto-check     from Botling 2  nothing allowed yet · asks to change its own data · approve in Settings › Plugins",
    );
  });

  it("holds back imported server parts on botlingd start, preserves author: import and hasData asks, and restores on user plugin.grant", async () => {
    const root = testRoot("m6-04-e2e");
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const src = join(root, "v2");
    const dataDir = join(root, "v3");

    make2xFolder(src);
    // 1. Third-party plugin with a host (server) part -> held back on start until user grants "write"
    const srcHostTool = writePlugin(join(src, "plugins"), "host-tool", {
      permissions: ["files"],
      commands: [{ id: "host-tool.ping", title: "Ping" }],
      host: `import { writeFileSync } from "node:fs";
import { join } from "node:path";
export function activate(ccb) {
  writeFileSync(join(ccb.storage.dir ?? ".", "started.flag"), "ran");
  ccb.commands.register("host-tool.ping", () => "pong:restored");
}
`,
    });
    // 2. Third-party plugin asking only "messages", but with non-empty plugin-data -> ask "write" must survive botlingd start
    writePlugin(join(src, "plugins"), "data-tool", { permissions: ["messages"] });
    mkdirSync(join(src, "plugin-data", "data-tool"), { recursive: true });
    writeFileSync(join(src, "plugin-data", "data-tool", "store.json"), JSON.stringify({ items: [1] }));

    const importRes = await runImport({ sourceDir: src, targetDir: dataDir, dryRun: false });
    expect(importRes.problems).toEqual([]);
    expect(importRes.reportText).toContain("host-tool");
    expect(importRes.reportText).toContain("approve in Settings › Plugins");

    const hostToolHash = folderHash(srcHostTool);

    // Start botlingd on the imported folder
    const daemon1 = await Botlingd.start({
      env: botlingdEnv(dataDir, { BOTLING_SERVER_PORT: "off", BOTLING_SERVER_BACKUP_CHECK_MS: "0" }),
      outDir: join(desktop, "out"),
    });
    const client1 = new ScriptClient("m6-04-1");
    try {
      await client1.connect(daemon1.paths.socket, daemon1.token);
      await client1.sub(client1.srv);
      const srvSnap = await client1.wait((m): m is MessageOf<"snap"> => m.t === "snap" && m.stream === client1.srv, "srv snap");
      const inc = srvSnap.logId;
      const originEpoch = client1.originEpoch;

      // Verify plugins.list shows host-tool held back and grant === "none"
      const listRes = await client1.req({ type: "plugins.list" });
      expect(listRes.ok).toBe(true);
      if (!listRes.ok) throw new Error(listRes.error.message);
      const view = listRes.result as PluginsView;
      const hostEntry = view.plugins.find((p) => p.name === "host-tool");
      expect(hostEntry).toBeDefined();
      expect(hostEntry?.failure).toBe(HELD_BACK_NOTICE);
      expect(hostEntry?.grant).toBe("none");

      // Server part did not run and command is refused
      expect(existsSync(join(dataDir, "plugin-data", "host-tool", "started.flag"))).toBe(false);
      const cmdBeforeSlot: Slot = { origin: client1.deviceId, originEpoch, target: client1.srv, n: 1 };
      client1.cmd(cmdBeforeSlot, { type: "plugins.command", id: "host-tool.ping" }, inc);
      const cmdBeforeRes = await client1.wait(isResult(cmdBeforeSlot), "host-tool.ping before grant");
      expect(cmdBeforeRes.outcome.kind).toBe("refused");

      // After botlingd startup sync, server.db must STILL preserve author: "import" and data-tool's write ask
      const rowsAfterStart = new Map(readAllPluginRows(dataDir).map((r) => [r.key, r.row]));
      expect(rowsAfterStart.get("plugin:host-tool")?.author).toBe("import");
      expect(rowsAfterStart.get("plugin:host-tool")?.grants).toEqual({});
      expect(rowsAfterStart.get("plugin:data-tool")?.author).toBe("import");
      expect(rowsAfterStart.get("plugin:data-tool")?.manifest.tier).toBe("write");
      expect(rowsAfterStart.get("plugin:data-tool")?.grants).toEqual({});

      // User restores data-tool to write via plugin.grant (fails if botlingd downgraded manifest.tier to "read")
      const dataToolHash = rowsAfterStart.get("plugin:data-tool")!.codeHash;
      const grantDataSlot: Slot = { origin: client1.deviceId, originEpoch, target: client1.srv, n: 2 };
      client1.cmd(
        grantDataSlot,
        { type: "plugin.grant", plugin: "data-tool", codeHash: dataToolHash, tier: "write", reads: [], requests: [] },
        inc,
      );
      expect((await client1.wait(isResult(grantDataSlot), "grant data-tool")).outcome.kind).toBe("applied");

      // User restores host-tool to write via plugin.grant -> server part starts and command works
      const grantHostSlot: Slot = { origin: client1.deviceId, originEpoch, target: client1.srv, n: 3 };
      client1.cmd(
        grantHostSlot,
        { type: "plugin.grant", plugin: "host-tool", codeHash: hostToolHash, tier: "write", reads: [], requests: [] },
        inc,
      );
      expect((await client1.wait(isResult(grantHostSlot), "grant host-tool")).outcome.kind).toBe("applied");

      await until(
        () => existsSync(join(dataDir, "plugin-data", "host-tool", "started.flag")),
        { timeout: 10_000, what: "host-tool started.flag after grant" },
      );

      const cmdAfterSlot: Slot = { origin: client1.deviceId, originEpoch, target: client1.srv, n: 4 };
      client1.cmd(cmdAfterSlot, { type: "plugins.command", id: "host-tool.ping" }, inc);
      const cmdAfterRes = await client1.wait(isResult(cmdAfterSlot), "host-tool.ping after grant");
      expect(cmdAfterRes.outcome.kind).toBe("applied");

      const rowsAfterGrant = new Map(readAllPluginRows(dataDir).map((r) => [r.key, r.row]));
      expect(rowsAfterGrant.get("plugin:host-tool")?.author).toBe("import");
      expect(rowsAfterGrant.get("plugin:host-tool")?.grants[hostToolHash]?.grantedBy).toBe("user");
      expect(rowsAfterGrant.get("plugin:data-tool")?.author).toBe("import");
      expect(rowsAfterGrant.get("plugin:data-tool")?.grants[dataToolHash]?.grantedBy).toBe("user");
    } finally {
      client1.close();
      await daemon1.stop();
    }

    // Restart botlingd a second time: author: "import" and user grants persist; unapproved sample-plugin stays ungranted.
    const daemon2 = await Botlingd.start({
      env: botlingdEnv(dataDir, { BOTLING_SERVER_PORT: "off", BOTLING_SERVER_BACKUP_CHECK_MS: "0" }),
      outDir: join(desktop, "out"),
    });
    try {
      const rowsAfterRestart = new Map(readAllPluginRows(dataDir).map((r) => [r.key, r.row]));
      expect(rowsAfterRestart.get("plugin:host-tool")?.author).toBe("import");
      expect(rowsAfterRestart.get("plugin:host-tool")?.grants[hostToolHash]?.tier).toBe("write");
      expect(rowsAfterRestart.get("plugin:data-tool")?.author).toBe("import");
      expect(rowsAfterRestart.get("plugin:sample-plugin")?.author).toBe("import");
      expect(rowsAfterRestart.get("plugin:sample-plugin")?.grants).toEqual({});
    } finally {
      await daemon2.stop();
    }
  }, 60_000);

  it("fix round (M12): the import uses the trust pass up without trusting anything, even a row that was already in the target", async () => {
    const root = testRoot("m6-04-trust-mark");
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const src = join(root, "v2");
    const dataDir = join(root, "v3");
    make2xFolder(src);
    writePlugin(join(src, "plugins"), "host-tool", { permissions: ["files"] });
    await runImport({ sourceDir: src, targetDir: dataDir, dryRun: false });
    expect(readAllPluginRows(dataDir).find((r) => r.key === "plugin:host-tool")?.row.grants).toEqual({});
    // The import runs again over the rows it left (a run that stopped before its final mark, on a server.db without the
    // trust flag): the host-tool row is already there, with no record.
    const raw = new DatabaseSync(join(dataDir, "server.db"));
    try {
      raw.prepare("DELETE FROM meta WHERE key = 'plugin.trust.v1' OR key LIKE 'import:%'").run();
    } finally {
      raw.close();
    }
    await runImport({ sourceDir: src, targetDir: dataDir, dryRun: false });
    // "mark": nothing is trusted by the import (B-20(a)), the row that was already there included ...
    const row = readAllPluginRows(dataDir).find((r) => r.key === "plugin:host-tool")?.row;
    expect(row?.author).toBe("import");
    expect(pluginApproved(row ?? null)).toBe(false);
    // ... and the pass is used up, so botlingd's first sync does not trust it either.
    const db = openReaderDb(join(dataDir, "server.db"));
    try {
      expect(db.prepare("SELECT 1 AS x FROM meta WHERE key = 'plugin.trust.v1'").get()).toBeDefined();
    } finally {
      db.close();
    }
  }, 60_000);

  it("review fix: 2.x folder names and bot names reach the report as one escaped line (L-004)", async () => {
    const root = makeTempRoot("report-escape");
    const src = join(root, "v2");
    make2xFolder(src);
    // A 2.x plugin folder whose name forges a granted-looking plugin line, with an ESC, and a broken package.json.
    const forged = "bad\n  my-tool         from Botling 2  can change its own data\u001b[2J";
    mkdirSync(join(src, "plugins", forged), { recursive: true });
    writeFileSync(join(src, "plugins", forged, "package.json"), "{ not json");
    const live = await runImport({ sourceDir: src, targetDir: join(root, "v3"), dryRun: false });
    const problems = live.reportText.slice(live.reportText.indexOf("\nProblems\n"));
    expect(problems).toContain("plugins/bad\\x0a  my-tool         from Botling 2  can change its own data\\x1b[2J/package.json");
    expect(problems).not.toContain("\n  my-tool");
    expect(live.reportText).not.toContain("\u001b");

    const text = formatImportReport({
      dryRun: true,
      reportPath: "/tmp/r.md",
      bots: [{ oldId: "old\n1", newId: "n1", kind: "bot", name: "Ann\n  - forged\u2028x\u009b", lines: 0, skipped: 0, pins: 0, missingPinLines: 0, specs: 0, tasks: 0, subagents: 0, subagentSteps: 0 }],
      totalLines: 0, totalSkipped: 0, totalPins: 0, totalMissingPinLines: 0,
      idMap: [{ oldId: "old\n1", newId: "n1", kind: "bot", name: "Ann\n  - forged" }],
      settings: { movedPrefs: [], machineKeys: [], layoutKeys: [], oversizedKeys: [] },
      approvals: { folders: 0, movedFolders: 0, approvedCommandFolders: 0, movedCommandFolders: 0, alwaysAllowedCount: 0 },
      plugins: [],
      problems: ["p\r\n  - forged"],
    });
    expect(text).toContain("  Ann\\x0a  - forged\\u2028x\\x9b [bot]");
    expect(text).toContain("  old\\x0a1 -> n1  (bot, Ann\\x0a  - forged)");
    expect(text).toContain("  - p\\x0d\\x0a  - forged");
    expect(text.split("\n").filter((line) => line.includes("forged"))).toHaveLength(3);
  });
});
