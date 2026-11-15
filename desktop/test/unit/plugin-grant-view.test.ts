// M5-14d: the 2.x desktop window's Plugins list shows each plugin's grant on this machine, read-only,
// with the CLI line to change non-built-in plugins; 2.x cores leave `grant` unset and show nothing new.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { folderHash } from "../../src/core/plugins/catalog";
import { Botlingd, readPluginGrant } from "../../src/server/botlingd";
import { botlingdEnv, testRoot } from "../botlingd-harness";
import { join } from "node:path";
import { PROTOCOL_VERSION, PluginView, type Outbound, type PluginsView } from "../../src/contract";
import { coreProcessOptions } from "../../src/core/core-process";
import { Plugins, type PluginWorld } from "../../src/core/plugins";
import { Core, type CoreOptions } from "../../src/core/server";
import { PluginsPanel } from "../../src/renderer/Plugins";
import type { Client } from "../../src/renderer/client";
import { deleteRow, putRow } from "../../src/server/replica/tables";
import { openServerStore, type ServerStore } from "../../src/server/store";
import type { PluginRow } from "../../src/protocol/table-rows";
import { desktop, fakeCli, tempDir, until } from "../helpers";

const openCores: Core[] = [];
const openStores: ServerStore[] = [];

afterEach(async () => {
  for (const core of openCores.splice(0)) {
    await core.shutdown().catch(() => {});
  }
  for (const store of openStores.splice(0)) {
    await store.close().catch(() => {});
  }
});

function writePlugin(root: string, name: string, opts: { ccb?: Record<string, unknown> } = {}) {
  const folder = join(root, name);
  mkdirSync(join(folder, "dist"), { recursive: true });
  writeFileSync(
    join(folder, "package.json"),
    JSON.stringify({
      name,
      version: "1.0.0",
      engines: { ccb: "^2.0.0" },
      ccb: { web: "dist/web.js", ...opts.ccb },
    }),
  );
  writeFileSync(join(folder, "dist", "web.js"), "export function activate() {}");
}

function stubWorld(): PluginWorld {
  return {
    bots: () => [],
    send: () => ({ messageId: "m1" }),
    interrupt: async () => null,
    notice: () => {},
    ask: async () => ({ index: 0 }),
    openPanel: () => {},
    appSettings: () => ({ language: "en", botLook: "original", workerLimit: 4 }),
    shortcutOverrides: () => ({}),
    commandApproval: () => null,
    approveCommand: () => false,
    commandRun: () => null,
    component: () => null,
    imageUrls: () => null,
    createBot: () => { throw new Error("unused"); },
    addRoutine: () => "no-bot",
    chat: () => null,
    botId: () => null,
    decorated: () => {},
    engineCli: () => null,
    changed: () => {},
    broken: () => {},
    log: () => {},
    workspace: {
      bots: () => [],
      memory: () => ({ currentStatus: [], inProgress: [], decided: [], waitingOnYou: [] }),
      tasks: () => [],
      taskHistory: () => [],
      results: () => [],
      waiting: () => ({ items: [], doing: {} }),
      ignoreWaiting: () => {},
      pendingApprovals: () => [],
      face: () => "",
      current: () => ({ botId: "main", engine: "claude", sessionId: "s1", heads: [], view: "chat", tab: null }),
    },
    workspaceWatch: () => {},
  };
}

function createCore(dir: string, extra: Partial<CoreOptions> = {}) {
  const outbound: Outbound[] = [];
  const base = coreProcessOptions({
    env: {
      BOTLING_AGENT: "fake",
      BOTLING_FAKE_CLI: fakeCli,
      BOTLING_COMPONENT_SCAN_MS: "0",
      BOTLING_WAITING_SCAN_MS: "0",
      BOTLING_ROUTINE_TICK_MS: "0",
      BOTLING_WATCH_MS: "0",
      BOTLING_QUIT_TIDY_MS: "0",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
    dataDir: dir,
    outDir: join(dir, "unused-out"),
    emit: (message) => outbound.push(message),
    log: () => {},
    node: null,
    sealer: null,
    app: null,
  });
  const core = new Core({ ...base, plugins: null, ...extra });
  openCores.push(core);
  return { core, outbound };
}

async function call(core: Core, outbound: Outbound[], cmd: unknown, id = `req-${Math.random().toString(36).slice(2)}`) {
  core.receive({ v: PROTOCOL_VERSION, id, cmd });
  const response = await until(() =>
    outbound.find((m): m is Extract<Outbound, { id: string }> => "id" in m && m.id === id),
  );
  if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`);
  return response.result as any;
}

const basePlugin = (over: Partial<PluginView> = {}): PluginView => ({
  name: "my-tool",
  title: "My Tool",
  version: "1.0.0",
  description: null,
  enabled: true,
  failure: null,
  installedFrom: null,
  permissions: [],
  parts: ["web"],
  settings: [],
  commands: [],
  panels: [],
  ...over,
});

const draw = (plugins: PluginView[]) =>
  renderToStaticMarkup(
    createElement(PluginsPanel, {
      client: {} as Client,
      plugins: { plugins, broken: [], host: { running: true, problem: null }, secretsProblem: null } as PluginsView,
      onPanel() {},
      onClose() {},
      embedded: true,
    }),
  );

describe("M5-14d: PluginView schema", () => {
  it("accepts each valid grant tier and omitted grant, and refuses an unknown tier", () => {
    expect(PluginView.safeParse(basePlugin()).success).toBe(true);
    for (const grant of ["none", "read", "request", "write"] as const) {
      expect(PluginView.safeParse(basePlugin({ grant })).success, grant).toBe(true);
    }
    for (const bad of ["admin", "all", "", null, 42]) {
      expect(PluginView.safeParse({ ...basePlugin(), grant: bad }).success, String(bad)).toBe(false);
    }
  });
});

describe("M5-14d: Plugins.view() and CoreOptions.pluginGrant", () => {
  it("sets grant on each plugin when pluginGrant answers non-null, and omits it when null or unset (2.x)", () => {
    const dir = tempDir("plugin-grant-view");
    writePlugin(join(dir, "plugins"), "alpha");
    writePlugin(join(dir, "plugins"), "beta");
    writePlugin(join(dir, "plugins"), "gamma");

    const v3 = new Plugins({
      dataDir: dir,
      world: stubWorld(),
      node: null,
      hostScript: "",
      sealer: null,
      pluginGrant: (name) => (name === "alpha" ? "read" : name === "beta" ? "none" : null),
    });
    const v3List = v3.view().plugins;
    expect(v3List.find((p) => p.name === "alpha")?.grant).toBe("read");
    expect(v3List.find((p) => p.name === "beta")?.grant).toBe("none");
    const gamma = v3List.find((p) => p.name === "gamma")!;
    expect(gamma.grant).toBeUndefined();
    expect("grant" in gamma).toBe(false);

    const v2 = new Plugins({
      dataDir: dir,
      world: stubWorld(),
      node: null,
      hostScript: "",
      sealer: null,
    });
    for (const item of v2.view().plugins) {
      expect(item.grant).toBeUndefined();
      expect("grant" in item).toBe(false);
    }
  });

  it("threads CoreOptions.pluginGrant to Plugins.view() in plugins.list, while 2.x Core omits grant", async () => {
    const dir3 = tempDir("core-grant-v3");
    writePlugin(join(dir3, "plugins"), "helper");
    let tier: "none" | "read" | "request" | "write" = "none";
    const v3 = createCore(dir3, { pluginGrant: (name) => (name === "helper" ? tier : null) });
    const first = await call(v3.core, v3.outbound, { type: "plugins.list" });
    expect(first.plugins.find((p: PluginView) => p.name === "helper")?.grant).toBe("none");
    tier = "request";
    const second = await call(v3.core, v3.outbound, { type: "plugins.list" });
    expect(second.plugins.find((p: PluginView) => p.name === "helper")?.grant).toBe("request");

    const dir2 = tempDir("core-grant-v2");
    writePlugin(join(dir2, "plugins"), "helper");
    const v2 = createCore(dir2);
    const list2 = await call(v2.core, v2.outbound, { type: "plugins.list" });
    const helper2 = list2.plugins.find((p: PluginView) => p.name === "helper")!;
    expect(helper2.grant).toBeUndefined();
    expect("grant" in helper2).toBe(false);
  });
});

describe("M5-14d: readPluginGrant from server.db", () => {
  it("reads the grant at the row's current codeHash, returns none when absent/stale/tombstoned, and updates lazily", async () => {
    const dir = tempDir("read-plugin-grant");
    const store = await openServerStore(dir);
    openStores.push(store);
    const serverId = "srv-local-1";
    const stream = `srv:${serverId}`;
    const reader = store.openReader();

    // Before rows are built (lazy): returns "none".
    expect(readPluginGrant(reader, serverId, "my-tool")).toBe("none");

    const makeRow = (codeHash: string, grants: PluginRow["grants"]): PluginRow => ({
      codeHash,
      manifest: {
        tier: "write",
        reads: [],
        requests: ["chat.send"],
        owns: [],
        provides: [],
        requires: [],
        uses: [],
        clients: [],
        needsShell: [],
      },
      author: "user",
      grants,
    });

    // Empty grants -> "none".
    await store.submit((tx) => {
      putRow(tx, stream, "plugin:my-tool", makeRow("sha256:curr", {}));
    });
    expect(readPluginGrant(reader, serverId, "my-tool")).toBe("none");

    // Grant only for an old codeHash -> "none" at current codeHash.
    await store.submit((tx) => {
      putRow(tx, stream, "plugin:my-tool", makeRow("sha256:curr", {
        "sha256:old": { tier: "write", reads: [], requests: [], grantedBy: "user", at: 10 },
      }));
    });
    expect(readPluginGrant(reader, serverId, "my-tool")).toBe("none");

    // Grant at current codeHash -> returns its tier.
    await store.submit((tx) => {
      putRow(tx, stream, "plugin:my-tool", makeRow("sha256:curr", {
        "sha256:old": { tier: "write", reads: [], requests: [], grantedBy: "user", at: 10 },
        "sha256:curr": { tier: "request", reads: [], requests: ["chat.send"], grantedBy: "user", at: 20 },
      }));
    });
    expect(readPluginGrant(reader, serverId, "my-tool")).toBe("request");

    // Tombstoned -> "none".
    await store.submit((tx) => {
      deleteRow(tx, stream, "plugin:my-tool", Date.now());
    });
    expect(readPluginGrant(reader, serverId, "my-tool")).toBe("none");

    // Malformed row -> fail closed ("none").
    await store.submit((tx) => {
      tx.prepare("INSERT OR REPLACE INTO rows (stream, key, rev, body, deleted) VALUES (?, ?, 99, ?, 0)")
        .run(stream, "plugin:broken", JSON.stringify({ codeHash: "sha256:x", grants: "bad" }));
    });
    expect(readPluginGrant(reader, serverId, "broken")).toBe("none");

    // A reader that throws (closed store, shutdown) -> fail closed ("none").
    const throwing = { prepare() { throw new Error("database is closed"); } } as unknown as typeof reader;
    expect(readPluginGrant(throwing, serverId, "my-tool")).toBe("none");
  });
});

describe("M5-14d: PluginsPanel renderer", () => {
  it("shows exact tier wording for each tier and the CLI line only for non-built-in plugins", () => {
    const cases: Array<{ grant: NonNullable<PluginView["grant"]>; expected: string }> = [
      { grant: "none", expected: "Allowed on this machine: nothing yet" },
      { grant: "read", expected: "Allowed on this machine: Read only" },
      { grant: "request", expected: "Allowed on this machine: Send what it asks for" },
      { grant: "write", expected: "Allowed on this machine: Change its own data on the server" },
    ];
    for (const { grant, expected } of cases) {
      const html = draw([basePlugin({ name: "my-tool", grant })]);
      expect(html, grant).toContain(`<div class="plugin-meta">${expected}</div>`);
      expect(html, grant).toContain(`<div class="plugin-meta">To change it: botlingd plugins grant my-tool --tier read|request|write</div>`);
    }

    const builtInHtml = draw([basePlugin({ name: "botling.note", title: "Note", builtIn: true, grant: "write" })]);
    expect(builtInHtml).toContain(`<div class="plugin-meta">Allowed on this machine: Change its own data on the server</div>`);
    expect(builtInHtml).not.toContain("To change it: botlingd plugins grant");
  });

  it("shows nothing new in 2.x (grant omitted) and renders no extra buttons or inputs (read-only)", () => {
    const v2Html = draw([basePlugin({ name: "my-tool" })]);
    expect(v2Html).not.toContain("Allowed on this machine");
    expect(v2Html).not.toContain("botlingd plugins grant");

    const v3Html = draw([basePlugin({ name: "my-tool", grant: "read" })]);
    expect(v3Html.match(/<button/g) ?? []).toEqual(v2Html.match(/<button/g) ?? []);
    expect(v3Html.match(/<input/g) ?? []).toEqual(v2Html.match(/<input/g) ?? []);
  });
});

describe("M5-14d: botlingd keeps the window's list on the running hash", () => {
  it("re-announces the list after plugin.grant and after a hot swap (no stale hash shown as current)", async () => {
    const dir = testRoot("plugin-grant-view-daemon");
    const daemon = await Botlingd.start({ env: botlingdEnv(dir, { BOTLING_SERVER_PORT: "off", BOTLING_SERVER_BACKUP_CHECK_MS: "0" }), outDir: join(desktop, "out") });
    const stream = `srv:${daemon.serverId}`;
    const sql = <T>(q: string, ...args: string[]): T | undefined => {
      const db = new DatabaseSync(join(dir, "server.db"), { readOnly: true });
      try { db.exec("PRAGMA busy_timeout = 10000"); return db.prepare(q).get(...args) as T | undefined; } finally { db.close(); }
    };
    const codeHash = () => { const row = sql<{ body: string }>("SELECT body FROM rows WHERE stream = ? AND key = 'plugin:probe.tool' AND deleted = 0", stream); return row ? JSON.parse(row.body).codeHash : null; };
    // The last list the core announced (snapshot or plugins.updated): what the window shows.
    const shown = () => (JSON.parse((daemon.core as any).lastPlugins).plugins as PluginView[]).find((p) => p.name === "probe.tool");
    const write = (version: string, code: string) => {
      const folder = join(dir, "plugins", "probe.tool");
      mkdirSync(join(folder, "dist"), { recursive: true });
      writeFileSync(join(folder, "package.json"), JSON.stringify({ name: "probe.tool", version, engines: { ccb: "^2.0.0" }, ccb: { permissions: ["composer"], web: "dist/web.js" } }));
      writeFileSync(join(folder, "dist", "web.js"), code);
      return folder;
    };
    try {
      const folder = write("1.0.0", "export function activate() { return 1; }\n");
      daemon.core.plugins.scan();
      const h1 = folderHash(folder);
      await until(() => codeHash() === h1 || null, { timeout: 5_000, every: 50, what: "row at h1" });
      expect(shown()?.grant).toBe("none");

      const status = await daemon.runtime.receive({
        slot: { origin: "desktop", originEpoch: "a".repeat(32), target: stream, n: 1 }, floor: 1,
        inc: String(sql<{ logId: string }>("SELECT logId FROM streams WHERE stream = ?", stream)!.logId),
        cmd: { type: "plugin.grant", plugin: "probe.tool", codeHash: h1, tier: "request", reads: [], requests: ["chat.send"] },
      } as any, { scope: "local" });
      expect((status as any).message.outcome).toMatchObject({ kind: "applied" });
      await until(() => shown()?.grant === "request" || null, { timeout: 2_000, every: 20, what: "window shows the grant" });

      write("1.0.1", "export function activate() { return 2; }\n");
      daemon.core.plugins.scan();
      const h2 = folderHash(folder);
      await until(() => codeHash() === h2 || null, { timeout: 5_000, every: 50, what: "row at h2" });
      await until(() => (shown()?.version === "1.0.1" && shown()?.grant === "none") || null, { timeout: 2_000, every: 20, what: "window drops the old hash's grant" });
    } finally {
      await daemon.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
