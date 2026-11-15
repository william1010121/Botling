import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PERMISSIONS } from "../../src/core/plugins/manifest";
import { PluginRegistry } from "../../src/core/plugins/registry";
import { MemorySecretStore } from "../../src/core/plugins/secrets";
import { PluginRow, type Tier } from "../../src/protocol/table-rows";
import { importPlugins } from "../../src/server/import/plugins";
import {
  formatPluginsReportSection,
  readPluginReportEntries,
} from "../../src/server/import/report";
import {
  hasPluginData,
  installedFromRegistry,
  manifestAsks,
  reconcilePluginRows,
  requestsOf,
  tierOf,
} from "../../src/server/replica/plugin-rows";
import { ownTableStream, readRowBody } from "../../src/server/replica/tables";
import { make2xFolder } from "../support/fixture-2x";
import { memoryStore } from "./server-slots-harness";

function writePluginFolder(
  root: string,
  name: string,
  options: { version?: string; permissions?: string[] } = {},
): string {
  const folder = join(root, name);
  mkdirSync(folder, { recursive: true });
  writeFileSync(
    join(folder, "package.json"),
    JSON.stringify({
      name,
      version: options.version ?? "1.0.0",
      engines: { ccb: "^2.0.0" },
      ccb: {
        ...(options.permissions ? { permissions: options.permissions } : {}),
        web: "web.js",
      },
    }),
  );
  writeFileSync(join(folder, "web.js"), `export function activate() { return "${name}"; }\n`);
  return folder;
}

describe("M6-03b: 2.x permissions -> tier and requests mapping", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "botling-import-plugin-tiers-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("maps each of the 12 PERMISSIONS names and combinations per §14.4", () => {
    expect(Object.keys(PERMISSIONS).sort()).toEqual([
      "app",
      "bots",
      "cards",
      "claude",
      "composer",
      "exec",
      "files",
      "messages",
      "network",
      "routines",
      "sessions",
      "studio",
    ]);

    expect(tierOf([])).toBe("read");
    expect(requestsOf([])).toEqual([]);

    expect(tierOf(["messages"])).toBe("read");
    expect(requestsOf(["messages"])).toEqual([]);

    expect(tierOf(["composer"])).toBe("request");
    expect(requestsOf(["composer"])).toEqual(["chat.send"]);

    expect(tierOf(["bots"])).toBe("request");
    expect(requestsOf(["bots"])).toEqual(["bots.create", "chat.send"]);

    expect(tierOf(["claude"])).toBe("request");
    expect(requestsOf(["claude"])).toEqual(["chat.send"]);

    for (const perm of ["network", "files", "exec", "sessions", "routines", "cards", "app", "studio"]) {
      expect(tierOf([perm])).toBe("write");
      expect(requestsOf([perm])).toEqual([]);
    }

    expect(tierOf(["messages", "composer"])).toBe("request");
    expect(requestsOf(["messages", "composer"])).toEqual(["chat.send"]);

    expect(tierOf(["composer", "bots", "claude"])).toBe("request");
    expect(requestsOf(["composer", "bots", "claude"])).toEqual(["bots.create", "chat.send"]);

    expect(tierOf(["composer", "files"])).toBe("write");
    expect(requestsOf(["composer", "files"])).toEqual(["chat.send"]);
  });

  it("elevates a plugin with a non-empty data folder to write, while empty data folders do not", () => {
    expect(tierOf([], { hasData: true })).toBe("write");
    expect(tierOf(["messages"], { hasData: true })).toBe("write");
    expect(tierOf(["composer"], { hasData: true })).toBe("write");

    const ask = manifestAsks(["composer"], { hasData: true });
    expect(ask.tier).toBe("write");
    expect(ask.requests).toEqual(["chat.send"]);

    const dataRoot = join(root, "plugin-data");
    mkdirSync(join(dataRoot, "empty-plugin"), { recursive: true });
    mkdirSync(join(dataRoot, "non-empty-plugin"), { recursive: true });
    writeFileSync(join(dataRoot, "non-empty-plugin", "data.json"), "{}");

    expect(hasPluginData(dataRoot, "missing-plugin")).toBe(false);
    expect(hasPluginData(dataRoot, "empty-plugin")).toBe(false);
    expect(hasPluginData(dataRoot, "non-empty-plugin")).toBe(true);
  });

  it("writes plugin:<name> rows with author import and NO grant (per B-20)", async () => {
    const src = join(root, "v2");
    const dst = join(root, "v3");
    const builtIns = join(root, "builtins");
    mkdirSync(builtIns, { recursive: true });

    const fx = make2xFolder(src);
    writePluginFolder(join(src, "plugins"), "reading-coach", { permissions: ["composer", "messages"] });
    writePluginFolder(join(src, "plugins"), "quiet-reader", { permissions: ["messages"] });
    writePluginFolder(builtIns, "note", { permissions: ["files"] });

    const imported = importPlugins(src, dst, { builtInsDir: builtIns });
    expect(imported.problems).toEqual([]);

    const registry = new PluginRegistry(
      join(dst, "plugins"),
      join(dst, "plugins.json"),
      new MemorySecretStore(),
      builtIns,
    );
    const inputs = installedFromRegistry(registry.plugins, {
      author: "import",
      dataRoot: join(dst, "plugin-data"),
    });

    const { db, writer } = memoryStore();
    const stream = ownTableStream(db);
    const now = 1_700_000_000_000;
    await writer.submit((tx) => reconcilePluginRows(tx, stream, inputs, now));

    const noteRow = PluginRow.parse(readRowBody(db, stream, "plugin:note"));
    expect(noteRow.author).toBe("builtin");
    expect(noteRow.manifest.tier).toBe("write");
    expect(noteRow.grants[noteRow.codeHash]).toMatchObject({
      tier: "write",
      grantedBy: "builtin",
    });

    const coachRow = PluginRow.parse(readRowBody(db, stream, "plugin:reading-coach"));
    expect(coachRow.author).toBe("import");
    expect(coachRow.manifest.tier).toBe("request");
    expect(coachRow.manifest.requests).toEqual(["chat.send"]);
    expect(coachRow.grants).toEqual({});

    const quietRow = PluginRow.parse(readRowBody(db, stream, "plugin:quiet-reader"));
    expect(quietRow.author).toBe("import");
    expect(quietRow.manifest.tier).toBe("read");
    expect(quietRow.manifest.requests).toEqual([]);
    expect(quietRow.grants).toEqual({});

    // Fixture sample-plugin only asks for "messages", but has non-empty plugin-data -> tier "write", still no grant.
    const sampleRow = PluginRow.parse(readRowBody(db, stream, `plugin:${fx.pluginName}`));
    expect(sampleRow.author).toBe("import");
    expect(sampleRow.manifest.tier).toBe("write");
    expect(sampleRow.manifest.requests).toEqual([]);
    expect(sampleRow.grants).toEqual({});

    await writer.close();
    db.close();
  });

  it("formats the exact import report Plugins section for built-in and imported plugins", async () => {
    const src = join(root, "v2");
    const dst = join(root, "v3");
    const builtIns = join(root, "builtins");
    mkdirSync(builtIns, { recursive: true });
    mkdirSync(join(src, "plugins"), { recursive: true });

    writePluginFolder(builtIns, "note", { permissions: ["files"] });
    writePluginFolder(join(src, "plugins"), "reading-coach", { permissions: ["composer"] });
    writePluginFolder(join(src, "plugins"), "my-tool", { permissions: ["messages"] });
    mkdirSync(join(src, "plugin-data", "my-tool"), { recursive: true });
    writeFileSync(join(src, "plugin-data", "my-tool", "store.json"), JSON.stringify({ items: [1] }));

    importPlugins(src, dst, { builtInsDir: builtIns });
    const registry = new PluginRegistry(
      join(dst, "plugins"),
      join(dst, "plugins.json"),
      new MemorySecretStore(),
      builtIns,
    );
    const inputs = installedFromRegistry(registry.plugins, {
      author: "import",
      dataRoot: join(dst, "plugin-data"),
    });

    const { db, writer } = memoryStore();
    const stream = ownTableStream(db);
    await writer.submit((tx) => reconcilePluginRows(tx, stream, inputs, 1_700_000_000_000));

    const entries = readPluginReportEntries(db, stream);
    // Reorder to match the card example order: note, reading-coach, my-tool
    const byName = new Map(entries.map((entry) => [entry.name, entry]));
    const ordered = [byName.get("note")!, byName.get("reading-coach")!, byName.get("my-tool")!];

    expect(formatPluginsReportSection(ordered)).toBe([
      "Plugins",
      "  note            built in        can change its own data",
      "  reading-coach   from Botling 2  nothing allowed yet · asks to send messages · approve in Settings › Plugins",
      "  my-tool         from Botling 2  nothing allowed yet · asks to change its own data · approve in Settings › Plugins",
    ].join("\n"));

    // An imported plugin that asks only to read holds no grant either: it can do nothing until it is approved.
    const readOnlyLine = formatPluginsReportSection([
      {
        name: "note",
        row: byName.get("note")!.row,
      },
      {
        name: "plain-reader",
        row: {
          codeHash: "abc123",
          manifest: manifestAsks(["messages"]),
          author: "import",
          grants: {},
        },
      },
    ]);
    expect(readOnlyLine).toBe([
      "Plugins",
      "  note            built in        can change its own data",
      "  plain-reader    from Botling 2  nothing allowed yet · asks to read only · approve in Settings › Plugins",
    ].join("\n"));

    await writer.close();
    db.close();
  });
});
